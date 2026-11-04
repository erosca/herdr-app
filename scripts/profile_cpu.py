#!/usr/bin/env python3
"""Where a running herdr-app spends its CPU, written as a report you can share.

    scripts/profile_cpu.py [--seconds 20] [--wait-busy 200] [--pid PID] [--out DIR]

Start the load first (e.g. a parallel build printing in a Herdr terminal), then
run this, from a terminal outside Herdr if you can: Herdr would draw this
script's own output too. It watches the herdr-app window process (or --pid)
for --seconds:

  * every second, from /proc: CPU per thread, grouped by thread name
    (llvmpipe-0.. llvmpipe-31 count as one group), context switches, how many
    bytes the app read, the herdr-core processes' CPU, how many compiler
    processes run and how busy the whole machine is;
  * with Linux perf, if it is installed and allowed: CPU samples with call
    stacks, i.e. which functions and libraries each thread group runs.

The output folder (and a .tar.gz of it) holds report.txt, timeline.csv,
threads.csv and stacks.folded (for flamegraph.pl, inferno or speedscope.app).

Privacy. The output holds numbers, thread names, function names, library
file names without their folders, a short list of rendering-related
environment variables, the CPU count and the herdr-app version. It never
holds what terminals show, window or tab titles, command lines, file paths,
user or host names, other environment variables, or memory contents. Your
home folder, user name and host name are also filtered out of every string
read from the system, as a second line of defense. perf's raw data does hold
copies of stack memory, which can contain terminal text, so it stays in a
private temporary folder (mode 0700) and is deleted when this script ends;
--keep-raw keeps it for your own use. The .tar.gz carries no owner names.
Read report.txt before you share it.

perf: the `perf` package (Ubuntu: linux-tools-generic, Debian: linux-perf,
Fedora/Arch: perf). As your own user it needs kernel.perf_event_paranoid at 2
or lower, and then samples user space only (the thread table's sys% still
shows kernel time). Under sudo it samples kernel stacks too. --no-perf skips
it; the /proc part always runs. Python 3.8+ standard library only.
"""

import argparse
import collections
import csv
import glob
import os
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

CLK = os.sysconf("SC_CLK_TCK")

# The core that runs the terminals (`hc`), as a process name.
CORE_COMMS = {"hc", "herdr-core"}

# Compiler, assembler, linker and build-driver process names, counted to show
# how much of the build runs at once.
COMPILERS = {
    "cc1", "cc1plus", "cc1obj", "cc1objplus", "f951", "gnat1", "lto1", "lto-wrapper",
    "as", "ld", "ld.bfd", "ld.gold", "ld.lld", "lld", "mold", "collect2",
    "gcc", "g++", "cc", "c++", "clang", "clang++", "rustc", "nvcc", "cicc", "ptxas",
    "javac", "go", "zig", "make", "gmake", "ninja", "cmake", "cargo", "ccache", "sccache",
}

# Environment variables whose values matter for rendering. Values that look
# like paths are cut to their file name; nothing else is read from the
# environment.
ENV_VALUES = [
    "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
    "HERDR_TEST_GPU_BACKEND", "HERDR_RENDER_PARTIAL", "HERDR_RENDER_TRACE", "HERDR_RENDER_SKIP",
    "HERDR_TEST_PRESENT_MODE", "HERDR_VTE_COMPAT", "HERDR_FONT_HINTING",
    "ZED_FONTS_GAMMA", "ZED_DEVICE_ID",
    "WGPU_BACKEND", "WGPU_ADAPTER_NAME", "WGPU_POWER_PREF",
    "LP_NUM_THREADS", "GALLIUM_DRIVER", "LIBGL_ALWAYS_SOFTWARE", "LIBGL_ALWAYS_INDIRECT",
    "MESA_LOADER_DRIVER_OVERRIDE", "MESA_VK_DEVICE_SELECT",
    "__GLX_VENDOR_LIBRARY_NAME", "__EGL_VENDOR_LIBRARY_FILENAMES",
    "VK_ICD_FILENAMES", "VK_DRIVER_FILES",
]
# Only whether these are set, never their values.
ENV_PRESENCE = ["DISPLAY", "WAYLAND_DISPLAY", "HERDR_APP_HOME", "SSH_CONNECTION"]

GRAPHICS_LIB = re.compile(
    r"gallium|_dri\.so|swrast|llvmpipe|lvp|vulkan|nvidia|libGL|libEGL|libgbm|libLLVM|"
    r"zink|d3d12|radeon|amdgpu|iris|crocus|i915|nouveau|virgl|virtio|panfrost|freedreno|asahi",
    re.I,
)
RUST_HASH = re.compile(r"::h[0-9a-f]{16}\b")
# Rust's v0 symbols, demangled, carry each crate's hash: herdr_app[84a9861b5c192f2f]::paint.
RUST_CRATE_HASH = re.compile(r"(?<=[A-Za-z0-9_])\[[0-9a-f]{4,16}\](?=::|>|,|$)")
# Frames every stack of a thread passes through (process and thread start, Rust's
# runtime around them): left out of the inclusive lists.
TRUNK = re.compile(
    r"^(_start|main|__libc_start_main.*|__libc_start_call_main|clone3?|start_thread|thread_start|"
    r"std::rt::.*|std::sys::.*|std::sys_common::.*|std::panicking::.*|std::panic::.*|std::thread::.*|"
    r"core::ops::function::.*|__rust_try|.*__rust_begin_short_backtrace.*|"
    r"<alloc::boxed::Box<.*> as core::ops::function::FnOnce<.*>>::call_once.*)$"
)


def say(msg):
    print(f"profile_cpu: {msg}", file=sys.stderr, flush=True)


def read_text(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return None


def proc_stat(path):
    """(state, utime, stime) in clock ticks from a /proc .../stat file."""
    s = read_text(path)
    if not s:
        return None
    rest = s[s.rfind(")") + 2:].split()
    try:
        return rest[0], int(rest[11]), int(rest[12])
    except (IndexError, ValueError):
        return None


def status_fields(path, names):
    out = {}
    for line in (read_text(path) or "").splitlines():
        key, _, value = line.partition(":")
        if key in names:
            out[key] = value.strip()
    return out


def machine_ticks():
    """(busy, total) clock ticks of all CPUs since boot."""
    for line in (read_text("/proc/stat") or "").splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:9]]
            idle = v[3] + v[4]
            return sum(v) - idle, sum(v)
    return 0, 0


class Cleaner:
    """Every string read from the system goes through this before it is written:
    printable ASCII only, and the home folder, user and host names replaced."""

    def __init__(self, uid):
        homes, users, hosts = set(), set(), set()
        for u in {uid, os.getuid(), int(os.environ.get("SUDO_UID", os.getuid()))}:
            try:
                pw = pwd.getpwuid(u)
                homes.add(pw.pw_dir)
                users.add(pw.pw_name)
            except KeyError:
                pass
        homes.add(os.path.expanduser("~"))
        users.add(os.environ.get("USER", ""))
        users.add(os.environ.get("SUDO_USER", ""))
        name = socket.gethostname()
        hosts.update({name, name.split(".")[0]})
        try:
            hosts.add(socket.getfqdn())
        except OSError:
            pass
        self.homes = sorted((h.rstrip("/") for h in homes if h and h.rstrip("/")), key=len, reverse=True)
        # "root" names no one, and would garble symbols such as `find_root`.
        words = [(w, "<user>") for w in users if len(w) >= 3 and w != "root"]
        words += [(w, "<host>") for w in hosts if len(w) >= 3 and not w.startswith("localhost")]
        words.sort(key=lambda p: len(p[0]), reverse=True)
        self.words = [(re.compile(r"(?<![A-Za-z0-9])" + re.escape(w) + r"(?![A-Za-z0-9])", re.I), tag) for w, tag in words]
        self.replaced = 0
        self.cache = {}

    def __call__(self, s):
        hit = self.cache.get(s)
        if hit is not None:
            return hit
        out = "".join(c if " " <= c <= "~" else "?" for c in s)
        for home in self.homes:
            if home in out:
                self.replaced += out.count(home)
                out = out.replace(home, "<home>")
        for pattern, tag in self.words:
            out, n = pattern.subn(tag, out)
            self.replaced += n
        if len(self.cache) < 200_000:
            self.cache[s] = out
        return out


def basename_value(value, clean):
    """A variable's value with every path cut to its file name."""
    parts = re.split(r"([:;,])", value)
    return clean("".join(p.rstrip("/").rsplit("/", 1)[-1] if "/" in p else p for p in parts))[:80]


def group_of(comm, tid, pid, main_comm, clean):
    if tid == pid:
        return "main"
    if comm == main_comm:
        return "unnamed"
    name = re.sub(r"\d+", "N", clean(comm.strip())) or "?"
    return name


def find_target(want_uid):
    """The herdr-app window process: the one with the most threads (clients such
    as `herdr-app do` have one or two)."""
    best = None
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid() or (read_text(f"/proc/{pid}/comm") or "").strip() != "herdr-app":
            continue
        try:
            uid = os.stat(f"/proc/{pid}").st_uid
        except OSError:
            continue
        if want_uid is not None and uid != want_uid:
            continue
        threads = int(status_fields(f"/proc/{pid}/status", {"Threads"}).get("Threads", "0") or 0)
        if best is None or threads > best[1]:
            best = (pid, threads)
    return best[0] if best else None


class Snap:
    __slots__ = ("t", "app", "threads", "rchar", "rss_kb", "machine", "core", "compilers")


def snapshot(pid, uid):
    s = Snap()
    s.t = time.monotonic()
    st = proc_stat(f"/proc/{pid}/stat")
    if st is None:
        return None
    s.app = (st[1], st[2])
    s.threads = {}
    try:
        tids = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return None
    for tid in tids:
        base = f"/proc/{pid}/task/{tid}"
        ts = proc_stat(f"{base}/stat")
        if ts is None:
            continue
        comm = (read_text(f"{base}/comm") or "?").strip()
        cs = status_fields(f"{base}/status", {"voluntary_ctxt_switches", "nonvoluntary_ctxt_switches"})
        s.threads[int(tid)] = (comm, ts[1], ts[2], int(cs.get("voluntary_ctxt_switches", 0)),
                               int(cs.get("nonvoluntary_ctxt_switches", 0)))
    io = status_fields(f"/proc/{pid}/io", {"rchar"})
    s.rchar = int(io["rchar"]) if "rchar" in io else None
    rss = status_fields(f"/proc/{pid}/status", {"VmRSS"}).get("VmRSS", "0 kB").split()[0]
    s.rss_kb = int(rss) if rss.isdigit() else 0
    s.machine = machine_ticks()
    s.core, s.compilers = {}, {}
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit() or entry.name == str(pid):
            continue
        comm = (read_text(f"/proc/{entry.name}/comm") or "").strip()
        if comm in CORE_COMMS:
            try:
                if os.stat(f"/proc/{entry.name}").st_uid != uid:
                    continue
            except OSError:
                continue
            ps = proc_stat(f"/proc/{entry.name}/stat")
            if ps:
                s.core[int(entry.name)] = ps[1] + ps[2]
        elif comm in COMPILERS:
            ps = proc_stat(f"/proc/{entry.name}/stat")
            if ps:
                s.compilers[int(entry.name)] = (comm, ps[1] + ps[2], ps[0])
    return s


def app_ticks(pid):
    st = proc_stat(f"/proc/{pid}/stat")
    return None if st is None else st[1] + st[2]


def find_perf(explicit):
    """A perf that runs here. Ubuntu's /usr/bin/perf refuses to run when no
    linux-tools package matches the running kernel; any installed one works."""
    cands = [explicit] if explicit else []
    if not explicit:
        if shutil.which("perf"):
            cands.append(shutil.which("perf"))
        cands += sorted(glob.glob("/usr/lib/linux-tools*/perf") + glob.glob("/usr/lib/linux-tools/*/perf"), reverse=True)
    for c in cands:
        try:
            r = subprocess.run([c, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if r.returncode == 0 and r.stdout.startswith(b"perf version"):
            return c, r.stdout.decode().split()[2]
    return None, None


def perf_record_cmd(perf, pid, args, raw, root, mmap_pages):
    period = max(1, int(1e9 / args.freq))
    cmd = [perf, "record", "-q", "-N", "-o", raw, "-p", str(pid),
           "-e", "cpu-clock" if root else "cpu-clock:u", "-c", str(period)]
    cmd += ["--call-graph", f"dwarf,{args.stack_size}" if args.call_graph == "dwarf" else "fp"]
    if mmap_pages:
        cmd += ["-m", str(mmap_pages)]
    return cmd + ["--", "sleep", str(args.seconds)]


def start_perf(perf, pid, args, raw, root, errlog):
    """perf record running on the target, or (None, reason)."""
    for pages in (None, 128, 64, 32, 16):
        with open(errlog, "wb") as err:
            p = subprocess.Popen(perf_record_cmd(perf, pid, args, raw, root, pages), stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=err, start_new_session=True)
        try:
            p.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            return p, pages, None
        msg = read_text(errlog) or ""
        if "mmap" in msg or "mlock" in msg:
            continue
        lines = [l for l in msg.splitlines() if l.strip()]
        return None, None, lines[0][:200] if lines else f"perf record exited ({p.returncode})"
    return None, None, "perf could not map its sample buffers (raise kernel.perf_event_mlock_kb or run with sudo)"


def split_frame(rest):
    """'symbol (library)' -> (symbol, library), parentheses in either allowed."""
    if not rest.endswith(")"):
        return rest, ""
    depth = 0
    for i in range(len(rest) - 1, -1, -1):
        if rest[i] == ")":
            depth += 1
        elif rest[i] == "(":
            depth -= 1
            if depth == 0:
                return rest[:i].rstrip(), rest[i + 1:-1]
    return rest, ""


class Profile:
    """perf samples folded into counts. Nothing but cleaned symbol and library
    names and numbers is kept."""

    HEADER = re.compile(r"^\s*(.*?)\s+(\d+)/(\d+)\s*$")
    FRAME = re.compile(r"^\s+([0-9a-fA-F]+)\s+(.*)$")
    MAX_DEPTH = 120

    def __init__(self, pid, main_comm, exe_name, clean):
        self.pid, self.main_comm, self.exe_name, self.clean = pid, main_comm, exe_name, clean
        self.samples = collections.Counter()
        self.self_ = collections.defaultdict(collections.Counter)
        self.libs = collections.defaultdict(collections.Counter)
        self.incl = collections.defaultdict(collections.Counter)
        self.folded = collections.Counter()
        self.exe_frames = 0
        self.exe_unknown = 0
        self.sym_cache = {}
        self.dso_cache = {}

    def dso(self, d):
        hit = self.dso_cache.get(d)
        if hit is not None:
            return hit
        s = d.strip()
        if s.startswith("[kernel"):
            out = "[kernel]"
        elif s in ("[vdso]", "[vsyscall]", "[unknown]", ""):
            out = s or "[unknown]"
        elif s.startswith("//anon") or s.startswith("[anon") or s in ("[heap]", "[stack]"):
            out = "[anon]"
        elif "memfd:" in s:
            out = "[memfd]"
        elif re.search(r"perf-\d+\.map$", s):
            out = "[jit-map]"
        else:
            if s.endswith(" (deleted)"):
                s = s[: -len(" (deleted)")]
            out = self.clean(s.rstrip("/").rsplit("/", 1)[-1]) or "[unknown]"
        self.dso_cache[d] = out
        return out

    def sym(self, s):
        hit = self.sym_cache.get(s)
        if hit is not None:
            return hit
        out = s.strip()
        if not out or out == "[unknown]":
            out = ""
        else:
            out = re.sub(r"\+0x[0-9a-fA-F]+$", "", out)
            # Still mangled (perf can't read Rust's v0 symbols): demangle() finishes it.
            out = self.clean(out) if out.startswith(("_R", "_ZN")) else self.label(out)
        self.sym_cache[s] = out
        return out

    def label(self, name):
        name = RUST_CRATE_HASH.sub("", RUST_HASH.sub("", name))
        if len(name) > 160:
            name = name[:157] + "..."
        return self.clean(name).replace(";", ":")

    def demangle(self):
        """Names perf left mangled, through binutils' c++filt (Rust v0 and C++)."""
        names = set()
        for c in self.self_.values():
            names.update(label for label, _ in c)
        for c in self.incl.values():
            names.update(c)
        todo = sorted(n for n in names if n.startswith(("_R", "_ZN")))
        if not todo:
            return
        filt = shutil.which("c++filt")
        out = []
        if filt:
            try:
                r = subprocess.run([filt], input="\n".join(todo) + "\n", stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, universal_newlines=True, timeout=120)
                out = r.stdout.splitlines() if r.returncode == 0 else []
            except (OSError, subprocess.SubprocessError):
                out = []
        if len(out) != len(todo):
            out = todo
        names = {a: self.label(b) for a, b in zip(todo, out)}
        fix = lambda n: names.get(n, n)
        for group, c in self.self_.items():
            self.self_[group] = collections.Counter({(fix(l), d): k for (l, d), k in c.items()})
        for group, c in self.incl.items():
            self.incl[group] = collections.Counter({fix(l): k for l, k in c.items()})
        folded = collections.Counter()
        for stack, k in self.folded.items():
            parts = stack.split(";")
            folded[";".join(parts[:1] + [fix(p) for p in parts[1:]])] += k
        self.folded = folded

    def add(self, pid, tid, comm, frames):
        if pid == self.pid:
            group = group_of(comm, tid, self.pid, self.main_comm, self.clean)
        else:
            # perf follows processes the app starts while it records (mods' commands).
            group = "child:" + re.sub(r"\d+", "N", self.clean(comm.strip()))
        self.samples[group] += 1
        labels = []
        for sym, dso in frames[: self.MAX_DEPTH]:
            if dso == self.exe_name:
                self.exe_frames += 1
                self.exe_unknown += not sym
            labels.append(sym or (dso if dso.startswith("[") else f"[{dso}]"))
        if not labels:
            frames, labels = [("", "[unknown]")], ["[no stack]"]
        leaf_sym, leaf_dso = frames[0]
        self.self_[group][(labels[0], leaf_dso)] += 1
        self.libs[group][leaf_dso] += 1
        for label in set(labels):
            self.incl[group][label] += 1
        self.folded[";".join([group] + labels[::-1])] += 1

    def read(self, stream):
        cur = None
        for line in stream:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            m = self.FRAME.match(line) if line[0] in " \t" else None
            if m:
                if cur is not None:
                    sym, dso = split_frame(m.group(2))
                    cur[3].append((self.sym(sym), self.dso(dso)))
                continue
            h = self.HEADER.match(line)
            if h:
                if cur is not None:
                    self.add(*cur)
                cur = (int(h.group(2)), int(h.group(3)), h.group(1), [])
        if cur is not None:
            self.add(*cur)


def pct(part, whole):
    return 100.0 * part / whole if whole else 0.0


def analyse_snaps(snaps, pid, main_comm, clean):
    first, last = snaps[0], snaps[-1]
    elapsed = last.t - first.t
    groups = collections.OrderedDict()
    base = dict(first.threads)
    final = {}
    for snap in snaps:
        final.update(snap.threads)
    for tid, v in final.items():
        b = base.get(tid, (v[0], 0, 0, 0, 0))
        g = groups.setdefault(group_of(v[0], tid, pid, main_comm, clean),
                              {"tids": 0, "user": 0, "sys": 0, "vol": 0, "invol": 0, "peak": 0.0, "series": []})
        g["tids"] += 1
        g["user"] += v[1] - b[1]
        g["sys"] += v[2] - b[2]
        g["vol"] += v[3] - b[3]
        g["invol"] += v[4] - b[4]
    rows = []
    for i in range(1, len(snaps)):
        prev, cur = snaps[i - 1], snaps[i]
        dt = cur.t - prev.t
        per_group = collections.Counter()
        for tid, v in cur.threads.items():
            p = prev.threads.get(tid)
            used = (v[1] + v[2]) - ((p[1] + p[2]) if p else 0)
            per_group[group_of(v[0], tid, pid, main_comm, clean)] += used
        for name, g in groups.items():
            g["series"].append(pct(per_group[name] / CLK, dt))
            g["peak"] = max(g["peak"], g["series"][-1])
        app_user = (cur.app[0] - prev.app[0]) / CLK
        app_sys = (cur.app[1] - prev.app[1]) / CLK
        mb, mt = cur.machine[0] - prev.machine[0], cur.machine[1] - prev.machine[1]
        core = sum(t - prev.core.get(p, 0) for p, t in cur.core.items())
        comp_cpu = sum(c[1] - (prev.compilers[p][1] if p in prev.compilers else 0) for p, c in cur.compilers.items())
        alive = collections.Counter(c[0] for c in cur.compilers.values())
        running = sum(1 for c in cur.compilers.values() if c[2] == "R")
        rchar = (cur.rchar - prev.rchar) / dt if cur.rchar is not None and prev.rchar is not None else None
        rows.append({
            "t": cur.t - first.t, "dt": dt, "app": pct(app_user + app_sys, dt), "app_user": pct(app_user, dt),
            "app_sys": pct(app_sys, dt), "groups": per_group, "machine": pct(mb, mt),
            "core": pct(core / CLK, dt), "compile_cpu": pct(comp_cpu / CLK, dt), "alive": alive,
            "running": running, "rchar": rchar,
        })
    return elapsed, groups, rows


def fmt_table(header, rows, aligns=None):
    widths = [max(len(str(x)) for x in col) for col in zip(header, *rows)] if rows else [len(h) for h in header]
    aligns = aligns or ["<"] + [">"] * (len(header) - 1)
    out = []
    for r in [header] + rows:
        out.append("  ".join(f"{str(c):{a}{w}}" for c, a, w in zip(r, aligns, widths)).rstrip())
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pid", type=int, help="the herdr-app process (default: the window process of your user)")
    ap.add_argument("--seconds", type=int, default=20, help="how long to record (default 20)")
    ap.add_argument("--wait-busy", type=float, default=0, metavar="PCT",
                    help="start only once herdr-app uses this much CPU (100 = one core), e.g. 200")
    ap.add_argument("--wait-max", type=int, default=900, help="give up waiting for --wait-busy after this many seconds")
    ap.add_argument("--freq", type=int, default=99, help="perf samples per second of CPU time per thread (default 99)")
    ap.add_argument("--call-graph", choices=["dwarf", "fp"], default="dwarf",
                    help="how perf walks stacks: dwarf (default; works without frame pointers) or fp (cheaper)")
    ap.add_argument("--stack-size", type=int, default=16384, help="bytes of stack perf copies per sample with dwarf")
    ap.add_argument("--no-perf", action="store_true", help="only the /proc measurements")
    ap.add_argument("--perf", help="the perf binary to use")
    ap.add_argument("--out", help="output folder (default ./herdr-profile-DATE-TIME)")
    ap.add_argument("--keep-raw", action="store_true",
                    help="keep perf's raw data (holds stack memory: for you only, never share it)")
    args = ap.parse_args()
    if not sys.platform.startswith("linux"):
        sys.exit("profile_cpu: Linux only (it reads /proc and uses Linux perf)")

    root = os.geteuid() == 0
    sudo_uid = int(os.environ["SUDO_UID"]) if root and os.environ.get("SUDO_UID", "").isdigit() else None
    sudo_gid = int(os.environ["SUDO_GID"]) if root and os.environ.get("SUDO_GID", "").isdigit() else None
    pid = args.pid or find_target(sudo_uid if root else os.getuid())
    if not pid or not os.path.exists(f"/proc/{pid}"):
        sys.exit("profile_cpu: no running herdr-app window found (start Herdr, or pass --pid)")
    uid = os.stat(f"/proc/{pid}").st_uid
    clean = Cleaner(uid)
    main_comm = (read_text(f"/proc/{pid}/comm") or "herdr-app").strip()
    try:
        exe_link = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        exe_link = ""
    exe_deleted = exe_link.endswith(" (deleted)")
    exe_name = clean((exe_link[: -len(" (deleted)")] if exe_deleted else exe_link).rsplit("/", 1)[-1]) or main_comm
    say(f"watching herdr-app pid {pid}")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.abspath(args.out or f"herdr-profile-{stamp}")
    raw_dir = tempfile.mkdtemp(prefix="herdr-profile-raw-")  # 0700
    os.chmod(raw_dir, 0o700)
    raw = os.path.join(raw_dir, "perf.data")
    perf_proc = None
    try:
        # What the app runs with (privacy-safe parts only).
        env = {}
        environ = read_text(f"/proc/{pid}/environ")
        for item in (environ or "").split("\0"):
            k, _, v = item.partition("=")
            if k:
                env[k] = v
        facts = [f"CPUs: {os.cpu_count()} online"]
        try:
            facts[-1] += f", herdr-app may run on {len(os.sched_getaffinity(pid))}"
        except OSError:
            pass
        version = "?"
        try:
            def as_owner():
                if root:
                    os.setgroups([])
                    os.setgid(os.stat(f"/proc/{pid}").st_gid)
                    os.setuid(uid)
            r = subprocess.run([f"/proc/{pid}/exe", "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               stdin=subprocess.DEVNULL, timeout=10, preexec_fn=as_owner)
            if r.returncode == 0:
                version = clean(r.stdout.decode("utf-8", "replace").strip())[:60]
        except (OSError, subprocess.SubprocessError):
            pass
        facts.append(f"version: {version}" + (" (the binary on disk was replaced since it started:"
                                                  " perf may resolve its functions wrongly; restart Herdr first)"
                                                  if exe_deleted else ""))
        if environ is None:
            facts.append("environment: not readable")
        else:
            for k in ENV_VALUES:
                if k in env:
                    facts.append(f"{k}={basename_value(env[k], clean)}")
            facts.append("set: " + (", ".join(k for k in ENV_PRESENCE if k in env) or "none") + "; unset: "
                         + (", ".join(k for k in ENV_PRESENCE if k not in env) or "none"))
            if any(k.startswith("NX") for k in env):
                facts.append("NX_* variables present (NoMachine)")
        libs = set()
        for line in (read_text(f"/proc/{pid}/maps") or "").splitlines():
            parts = line.split(None, 5)
            if len(parts) == 6 and parts[5].startswith("/"):
                name = parts[5].replace(" (deleted)", "").rsplit("/", 1)[-1]
                if ".so" in name and GRAPHICS_LIB.search(name):
                    libs.add(clean(name))
        facts.append("graphics libraries loaded: " + (", ".join(sorted(libs)) or "none found"))
        paranoid = (read_text("/proc/sys/kernel/perf_event_paranoid") or "?").strip()

        # Wait for the load.
        if args.wait_busy > 0:
            say(f"waiting for herdr-app to pass {args.wait_busy:.0f}% CPU (start the build now; Ctrl+C stops)")
            prev, prev_t, waited = app_ticks(pid), time.monotonic(), 0
            while True:
                time.sleep(1)
                cur, now = app_ticks(pid), time.monotonic()
                if cur is None:
                    sys.exit("profile_cpu: herdr-app exited")
                used = pct((cur - prev) / CLK, now - prev_t)
                prev, prev_t, waited = cur, now, waited + 1
                if used >= args.wait_busy:
                    break
                if waited % 10 == 0:
                    say(f"herdr-app at {used:.0f}% CPU, still waiting")
                if waited >= args.wait_max:
                    sys.exit(f"profile_cpu: herdr-app stayed under {args.wait_busy:.0f}% for {args.wait_max}s")

        # perf
        perf_note = perf_mode = None
        perf, perf_version = (None, None) if args.no_perf else find_perf(args.perf)
        if args.no_perf:
            perf_note = "not used (--no-perf)"
        elif not perf:
            perf_note = ("not installed (Ubuntu: linux-tools-generic, Debian: linux-perf, Fedora/Arch: perf);"
                         " only /proc measurements")
        elif not root and paranoid.lstrip("-").isdigit() and int(paranoid) > 2:
            perf_note = (f"not allowed: kernel.perf_event_paranoid is {paranoid}. Run with sudo, or"
                         " `sudo sysctl kernel.perf_event_paranoid=2` (until reboot) and run again")
        else:
            perf_proc, pages, why = start_perf(perf, pid, args, raw, root, os.path.join(raw_dir, "record.err"))
            if perf_proc is None:
                perf_note = f"perf record failed: {clean(why)}"
            else:
                perf_mode = (f"perf {perf_version}, cpu-clock every {1000 / args.freq:.1f} ms of CPU per thread,"
                             f" {args.call_graph} stacks" + ("" if root else ", user space only")
                             + (f", {pages}-page buffers" if pages else ""))
        if perf_note:
            say(f"perf {perf_note}")

        # /proc sampling, the same window as perf.
        say(f"recording {args.seconds}s (Ctrl+C ends early)")
        snaps = [snapshot(pid, uid)]
        if snaps[0] is None:
            sys.exit("profile_cpu: cannot read herdr-app's /proc entries")
        start = snaps[0].t
        interrupted = False
        try:
            while snaps[-1].t - start < args.seconds - 0.05:
                time.sleep(max(0.0, min(1.0, start + len(snaps) - time.monotonic())))
                s = snapshot(pid, uid)
                if s is None:
                    say("herdr-app exited")
                    break
                snaps.append(s)
                if len(snaps) % 5 == 1:
                    r = pct((s.app[0] + s.app[1] - snaps[-6].app[0] - snaps[-6].app[1]) / CLK, s.t - snaps[-6].t)
                    say(f"{s.t - start:4.0f}s  herdr-app {r:.0f}% CPU")
        except KeyboardInterrupt:
            interrupted = True
            say("stopped early")
        if perf_proc is not None:
            if interrupted or perf_proc.poll() is None and snaps[-1].t - start < args.seconds - 1:
                try:
                    os.killpg(perf_proc.pid, signal.SIGINT)
                except OSError:
                    pass
            try:
                perf_proc.wait(timeout=120)
            except subprocess.TimeoutExpired:
                os.killpg(perf_proc.pid, signal.SIGKILL)
                perf_proc.wait()
        if len(snaps) < 2:
            sys.exit("profile_cpu: recorded less than a second")

        # perf samples -> counts
        profile = None
        lost = None
        if perf_proc is not None and os.path.exists(raw) and os.path.getsize(raw) > 0:
            size_mb = os.path.getsize(raw) / 1e6
            say(f"reading {size_mb:.0f} MB of perf samples (dwarf stacks can take a few minutes)")
            profile = Profile(pid, main_comm, exe_name, clean)
            errlog = os.path.join(raw_dir, "script.err")
            with open(errlog, "wb") as err:
                p = subprocess.Popen([perf, "script", "-i", raw, "-F", "comm,pid,tid,ip,sym,dso", "--no-inline"],
                                     stdout=subprocess.PIPE, stderr=err, stdin=subprocess.DEVNULL)
                profile.read(line.decode("utf-8", "replace") for line in p.stdout)
                p.wait()
            profile.demangle()
            msg = read_text(errlog) or ""
            m = re.search(r"Processed (\d+) events and lost (\d+) chunks", msg)
            lost = f"lost {m.group(2)} chunks of {m.group(1)} events" if m else None
            if p.returncode != 0 or not profile.samples:
                first_line = next((l for l in msg.splitlines() if l.strip()), f"exit {p.returncode}")
                perf_note = f"perf script found no samples ({clean(first_line)[:160]})"
                profile = None
        elif perf_proc is not None:
            perf_note = "perf recorded nothing (" + clean(next((l for l in (read_text(os.path.join(raw_dir, "record.err")) or "").splitlines() if l.strip()), "no output"))[:160] + ")"

        elapsed, groups, rows = analyse_snaps(snaps, pid, main_comm, clean)
        os.makedirs(out, exist_ok=True)
        write_outputs(out, args, snaps, elapsed, groups, rows, profile, facts, paranoid, root,
                      perf_note, perf_mode if profile else None, lost, clean, stamp)
        if sudo_uid is not None:
            for dirpath, _, files in os.walk(out):
                os.chown(dirpath, sudo_uid, sudo_gid if sudo_gid is not None else -1)
                for f in files:
                    os.chown(os.path.join(dirpath, f), sudo_uid, sudo_gid if sudo_gid is not None else -1)
        tar = out.rstrip("/") + ".tar.gz"

        def anonymous(info):
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            return info

        with tarfile.open(tar, "w:gz") as t:
            t.add(out, arcname=os.path.basename(out), filter=anonymous)
        if sudo_uid is not None:
            os.chown(tar, sudo_uid, sudo_gid if sudo_gid is not None else -1)
        if clean.replaced:
            say(f"privacy filter replaced {clean.replaced} home/user/host name occurrences")
        say(f"report: {os.path.join(out, 'report.txt')}")
        say(f"to share: {tar} (read report.txt first)")
    finally:
        if perf_proc is not None and perf_proc.poll() is None:
            try:
                os.killpg(perf_proc.pid, signal.SIGKILL)
            except OSError:
                pass
        if args.keep_raw and os.path.exists(raw):
            say(f"raw perf data kept for you only (holds stack memory; never share it): {raw}")
        else:
            shutil.rmtree(raw_dir, ignore_errors=True)


def write_outputs(out, args, snaps, elapsed, groups, rows, profile, facts, paranoid, root,
                  perf_note, perf_mode, lost, clean, stamp):
    n = len(rows)
    avg = lambda key: sum(r[key] for r in rows) / n
    peak = lambda key: max(r[key] for r in rows)
    app_avg = avg("app")
    order = sorted(groups, key=lambda g: -(groups[g]["user"] + groups[g]["sys"]))
    top = [g for g in order if g != "main"][:3]
    L = []
    w = L.append
    w("herdr-app CPU profile")
    w("=" * 21)
    w(f"recorded {time.strftime('%Y-%m-%d %H:%M', time.strptime(stamp, '%Y%m%d-%H%M%S'))}, {elapsed:.0f}s;"
      " 100% = one CPU core busy")
    w("")
    w("Setup")
    for f in facts:
        w(f"  {f}")
    w(f"  perf: {perf_mode or perf_note}" + (f" ({lost})" if lost and perf_mode else ""))
    w(f"  running as {'root' if root else 'the app user'}; kernel.perf_event_paranoid={paranoid}")
    w("")

    # Summary
    rates = [r["rchar"] for r in rows if r["rchar"] is not None]
    alive = collections.Counter()
    for r in rows:
        alive.update(r["alive"])
    w("Summary (per-second samples from /proc)")
    w(f"  herdr-app       avg {app_avg:6.0f}%   peak {peak('app'):6.0f}%   (user {avg('app_user'):.0f}%, kernel {avg('app_sys'):.0f}%)")
    w(f"  herdr-core      avg {avg('core'):6.0f}%   peak {peak('core'):6.0f}%   (hc processes)")
    w(f"  build tools     avg {avg('compile_cpu'):6.0f}%   (approximate: processes shorter than a second are partly missed)")
    if alive:
        w("                  alive on average: " + ", ".join(f"{c} {k / n:.1f}" for c, k in alive.most_common(8))
          + f"; running at once: avg {sum(r['running'] for r in rows) / n:.1f}")
    w(f"  whole machine   avg {avg('machine'):6.0f}% of all {os.cpu_count()} CPUs busy")
    if rates:
        w(f"  herdr-app read  avg {sum(rates) / len(rates) / 1024:8.0f} KiB/s, peak {max(rates) / 1024:.0f} KiB/s"
          " (all read() calls: terminal output from the core, files, display server)")
    w(f"  herdr-app RSS   {snaps[-1].rss_kb / 1024:.0f} MiB, {len(snaps[-1].threads)} threads")
    w("")

    # Hints
    hints = []
    total_ticks = sum(g["user"] + g["sys"] for g in groups.values()) or 1
    for name in order[:3]:
        share = pct(groups[name]["user"] + groups[name]["sys"], total_ticks)
        if name.startswith("llvmpipe") and share >= 30:
            hints.append(f"{share:.0f}% of herdr-app's CPU is in {name} threads: Mesa's software rasterizer"
                         " (llvmpipe for OpenGL, lavapipe for Vulkan) drawing the window on the CPU, one thread"
                         " per core by default. Expected with no GPU (remote desktop, VM) or software rendering"
                         " forced; LP_NUM_THREADS caps the threads, fewer redraws cut the work.")
    main = groups.get("main")
    if main and pct((main["user"] + main["sys"]) / CLK, elapsed) >= 85:
        hints.append("The main (UI) thread is close to a full core: reading terminal output, layout, text and"
                     " frame building can't keep up; see its call tree below.")
    if app_avg and avg("app_sys") / app_avg >= 0.25:
        hints.append(f"{pct(avg('app_sys'), app_avg):.0f}% of herdr-app's time is in the kernel: e.g. copying"
                     " frames to the display server, waking threads." + ("" if root else
                     " Run with sudo to see kernel stacks."))
    vol = sum(g["vol"] for g in groups.values())
    invol = sum(g["invol"] for g in groups.values())
    if invol > vol and invol / elapsed > 100:
        hints.append(f"Threads were preempted {invol / elapsed:.0f} times/s (more than they waited on their own):"
                     " they compete with the build for CPUs.")
    if avg("machine") >= 90:
        hints.append("The machine is saturated, so herdr-app and the build slow each other down.")
    if profile and profile.exe_frames and profile.exe_unknown / profile.exe_frames > 0.5:
        hints.append("Most herdr-app frames have no function names: this binary has no symbol table"
                     " (stripped); a plain `cargo build --release` keeps it.")
    w("Hints (automatic; check them against the tables)")
    for h in hints or ["(none)"]:
        w(f"  - {h}")
    w("")

    # Threads
    w(f"Threads by name (N = any number), CPU averaged over {elapsed:.0f}s")
    trows = []
    for name in order:
        g = groups[name]
        trows.append([name, g["tids"], f"{pct((g['user'] + g['sys']) / CLK, elapsed):.0f}", f"{g['peak']:.0f}",
                      f"{pct(g['user'] / CLK, elapsed):.0f}", f"{pct(g['sys'] / CLK, elapsed):.0f}",
                      f"{g['vol'] / elapsed:.0f}", f"{g['invol'] / elapsed:.0f}"])
    for line in fmt_table(["group", "threads", "cpu%", "peak%", "user%", "kernel%", "waits/s", "preempted/s"], trows):
        w("  " + line)
    w("")

    # Timeline
    w("Timeline (each row one second)")
    head = ["t", "app%", "main%"] + [f"{g[:14]}%" for g in top] + ["rest%", "machine%", "core%", "build", "KiB/s"]
    trows = []
    for r in rows:
        shown = r["groups"]["main"] + sum(r["groups"][g] for g in top)
        rest = sum(r["groups"].values()) - shown
        trows.append([f"{r['t']:.0f}", f"{r['app']:.0f}", f"{pct(r['groups']['main'] / CLK, r['dt']):.0f}"]
                     + [f"{pct(r['groups'][g] / CLK, r['dt']):.0f}" for g in top]
                     + [f"{pct(rest / CLK, r['dt']):.0f}", f"{r['machine']:.0f}", f"{r['core']:.0f}",
                        str(sum(r["alive"].values())), "" if r["rchar"] is None else f"{r['rchar'] / 1024:.0f}"])
    for line in fmt_table(head, trows, [">"] * len(head)):
        w("  " + line)
    w("  (build = compiler/linker/build-tool processes alive; KiB/s = bytes herdr-app read)")
    w("")

    if profile:
        total = sum(profile.samples.values())
        app_total = sum(v for k, v in profile.samples.items() if not k.startswith("child:"))
        w(f"perf: {total} samples ({total / args.freq:.0f} CPU-seconds)")
        w("  self = time in the function itself; [anon] = code without a file, e.g. llvmpipe's compiled shaders")
        w("")
        pgroups = [g for g, _ in profile.samples.most_common()]
        for name in pgroups[:8]:
            cnt = profile.samples[name]
            w(f"-- {name}: {pct(cnt, app_total if not name.startswith('child:') else total):.1f}% of herdr-app's samples"
              + (" (a process the app started)" if name.startswith("child:") else ""))
            frows = [[f"{pct(c, cnt):5.1f}", sym[:110], lib] for (sym, lib), c in profile.self_[name].most_common(15)]
            for line in fmt_table(["self%", "function", "library"], frows, [">", "<", "<"]):
                w("   " + line)
            w("   libraries (self): " + ", ".join(f"{lib} {pct(c, cnt):.0f}%" for lib, c in profile.libs[name].most_common(6)))
            w("")
        for name in pgroups[:3]:
            cnt = profile.samples[name]
            w(f"-- {name}: inclusive (the function and everything it calls), top 35;"
              " frames in every sample (thread start, main loop) left out")
            branch = [(l, c) for l, c in profile.incl[name].most_common()
                      if c < cnt * 0.995 and not TRUNK.match(l)][:35]
            frows = [[f"{pct(c, cnt):5.1f}", label[:120]] for label, c in branch]
            for line in fmt_table(["incl%", "function"], frows, [">", "<"]) if frows else ["   (every sample shares one stack)"]:
                w("   " + line)
            own = [(l, c) for l, c in profile.incl[name].most_common() if "herdr_app::" in l][:20]
            if own:
                w("   herdr-app's own code in it:")
                for label, c in own:
                    w(f"   {pct(c, cnt):5.1f}  {label[:120]}")
            w("")
        with open(os.path.join(out, "stacks.folded"), "w") as f:
            for stack, c in profile.folded.most_common():
                f.write(f"{stack} {c}\n")
        w("stacks.folded: every sampled stack (thread group first), for flamegraph.pl, inferno-flamegraph or speedscope.app")
        w("")

    w("Privacy: this folder holds only numbers, thread names, function and library names, the settings")
    w("listed under Setup and the CPU count. No terminal contents, titles, command lines, paths, user or")
    w("host names. perf's raw data (which holds stack memory) was deleted unless --keep-raw was given.")
    with open(os.path.join(out, "report.txt"), "w") as f:
        f.write("\n".join(L) + "\n")

    with open(os.path.join(out, "threads.csv"), "w", newline="") as f:
        c = csv.writer(f)
        c.writerow(["group", "threads", "cpu_pct", "peak_pct", "user_pct", "kernel_pct", "waits_per_s", "preempted_per_s"])
        for name in order:
            g = groups[name]
            c.writerow([name, g["tids"], round(pct((g["user"] + g["sys"]) / CLK, elapsed), 1), round(g["peak"], 1),
                        round(pct(g["user"] / CLK, elapsed), 1), round(pct(g["sys"] / CLK, elapsed), 1),
                        round(g["vol"] / elapsed, 1), round(g["invol"] / elapsed, 1)])
    with open(os.path.join(out, "timeline.csv"), "w", newline="") as f:
        c = csv.writer(f)
        names = list(order)
        c.writerow(["t_s", "app_pct", "app_user_pct", "app_kernel_pct"] + [f"{g}_pct" for g in names]
                   + ["machine_busy_pct", "core_pct", "build_cpu_pct", "build_procs", "build_running", "read_kib_s"])
        for r in rows:
            c.writerow([round(r["t"], 1), round(r["app"], 1), round(r["app_user"], 1), round(r["app_sys"], 1)]
                       + [round(pct(r["groups"][g] / CLK, r["dt"]), 1) for g in names]
                       + [round(r["machine"], 1), round(r["core"], 1), round(r["compile_cpu"], 1),
                          sum(r["alive"].values()), r["running"],
                          "" if r["rchar"] is None else round(r["rchar"] / 1024, 1)])


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("profile_cpu: stopped; nothing written")
