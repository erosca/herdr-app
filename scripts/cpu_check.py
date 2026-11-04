#!/usr/bin/env python3
"""Tests, one setup at a time, why herdr-app uses so much CPU on this machine,
and prints a short report to paste back.

    scripts/cpu_check.py [--seconds 12] [--only gpu,cap20] [--bin PATH]

Run it in the desktop session where Herdr is slow (e.g. NoMachine), with no
build running. It opens a test window several times, one per setup below, each
on its own temporary home and core session: your Herdr, its terminals and its
settings are not touched (your settings.json, themes and fonts are copied so
text looks the same). Keep the test window on screen, not minimized, while it
runs: about 5 minutes in all.

In each test window a terminal plays the same synthetic output:

  idle     a shell prompt, nothing printing
  scroll   build-like lines, nonstop (the window redraws up to ~30 times a second)
  burst10  the same lines, a screenful at a time, 10 times a second
  status   one status line rewritten 20 times a second (like ninja)
  hidden   scroll in a background tab while an idle shell is on screen

and it measures herdr-app's CPU, the part of it in the software rasterizer's
llvmpipe threads, the window's draws per second, the CPU each draw costs and
how much of the main thread's share goes to building the frame. With Linux perf
allowed (kernel.perf_event_paranoid 2 or lower), it also samples the main
thread while the GPU setup scrolls: which functions that time goes to.

Setups run by default (each opens a fresh test window):

  gpu          no backend forced (NVIDIA Vulkan here), Fifo present, no draw cap
  gpu-imm      gpu, Immediate present (no wait for the display's refresh)
  gpu-mailbox  gpu, Mailbox present
  gpu-yield    gpu, NVIDIA's driver told to sleep rather than spin while it waits
               (__GL_YIELD=USLEEP)
  cap30 .. cap10  gpu, draws capped at 30, 20 (the NoMachine launcher), 15 and 10
               a second (HERDR_MAX_FPS)

Earlier rounds' setups (--only to run them): gl (OpenGL on llvmpipe), gpu-30,
gpu-20, now, nopartial, lp4, quarter, auto, vgl and nxvgl.

The report holds numbers, GPU adapter names, the screen size and the CPU count:
no paths, user or host names, terminal contents or environment. Everything
the test windows wrote (homes, logs, counters) is deleted at the end.
"""

import argparse
import ctypes
import glob
import json
import os
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

CLK = os.sysconf("SC_CLK_TCK")
SOFTWARE = re.compile(r"llvmpipe|lavapipe|softpipe|swrast|swiftshader", re.I)
HERE = os.path.dirname(os.path.abspath(__file__))
SETTLE = 3.0

# The terminal program that plays each scenario's output, then stays quiet.
GEN = r'''
import sys, time
mode, secs = sys.argv[1], float(sys.argv[2])
parts = ["core", "net", "ui", "render", "storage", "util", "tests", "io"]
def line(i):
    p = parts[i % len(parts)]
    return (f"[{i // 40 % 100:3d}%] \033[32mBuilding CXX object\033[0m src/{p}/CMakeFiles/{p}.dir/"
            f"{p}_module_{i % 997:03d}_impl.cpp.o\n")
out, end, i = sys.stdout, time.monotonic() + secs, 0
while time.monotonic() < end:
    if mode == "scroll":
        out.write("".join(line(i + k) for k in range(30))); i += 30; pause = 0.01
    elif mode == "burst10":
        out.write("".join(line(i + k) for k in range(80))); i += 80; pause = 0.1
    else:
        out.write(f"\r\033[K[{i}/99999] \033[32mBuilding CXX object\033[0m src/core/module_{i % 997:03d}_impl.cpp.o")
        i += 1; pause = 0.05
    out.flush()
    time.sleep(pause)
time.sleep(10 ** 7)
'''

NOW = {"HERDR_TEST_GPU_BACKEND": "gl", "HERDR_RENDER_PARTIAL": "cpu"}
GPU = {"HERDR_RENDER_PARTIAL": "cpu"}
DEFAULT = ["gpu", "gpu-imm", "gpu-mailbox", "gpu-yield", "cap30", "cap20", "cap15", "cap10"]
FIFO = dict(GPU, HERDR_TEST_PRESENT_MODE="fifo")  # Fifo is the default; naming it logs the modes there are
# The setup and scenario whose main thread perf samples.
PERF_AT = ("gpu", "scroll")
# name, what it is, environment, wrapper, window, scenarios
SETUPS = [
    ("gl", "OpenGL on llvmpipe, partial redraw (the old NoMachine launcher)", NOW, None, "max", ["scroll"]),
    ("gpu", "no backend forced, Fifo present, draws not capped", FIFO, None, "max",
     ["idle", "scroll", "status", "hidden"]),
    ("gpu-imm", "gpu, Immediate present", dict(GPU, HERDR_TEST_PRESENT_MODE="immediate"), None, "max",
     ["scroll", "status"]),
    ("gpu-mailbox", "gpu, Mailbox present", dict(GPU, HERDR_TEST_PRESENT_MODE="mailbox"), None, "max", ["scroll"]),
    ("gpu-yield", "gpu, __GL_YIELD=USLEEP", dict(FIFO, __GL_YIELD="USLEEP"), None, "max", ["scroll"]),
    ("cap30", "gpu, draws capped at 30/s", dict(FIFO, HERDR_MAX_FPS="30"), None, "max", ["scroll"]),
    ("cap20", "gpu, draws capped at 20/s (the NoMachine launcher)", dict(FIFO, HERDR_MAX_FPS="20"), None, "max",
     ["scroll", "status"]),
    ("cap15", "gpu, draws capped at 15/s", dict(FIFO, HERDR_MAX_FPS="15"), None, "max", ["scroll"]),
    ("cap10", "gpu, draws capped at 10/s", dict(FIFO, HERDR_MAX_FPS="10"), None, "max", ["scroll"]),
    ("gpu-30", "gpu, draws capped at 30/s (the new NoMachine launcher)", dict(GPU, HERDR_MAX_FPS="30"), None, "max",
     ["idle", "scroll", "status"]),
    ("gpu-20", "gpu, draws capped at 20/s", dict(GPU, HERDR_MAX_FPS="20"), None, "max", ["scroll"]),
    ("now", "OpenGL, partial redraw (your NoMachine launcher)", NOW, None, "max",
     ["idle", "scroll", "burst10", "status", "hidden"]),
    ("nopartial", "OpenGL, partial redraw off", {"HERDR_TEST_GPU_BACKEND": "gl"}, None, "max", ["scroll", "status"]),
    ("lp4", "now + LP_NUM_THREADS=4", dict(NOW, LP_NUM_THREADS="4"), None, "max", ["scroll"]),
    ("quarter", "now, window 1/2 x 1/2 of the screen", NOW, None, "quarter", ["scroll"]),
    ("auto", "no backend forced (Vulkan and GL, GPUs first)", {"HERDR_RENDER_PARTIAL": "cpu"}, None, "max", ["scroll"]),
    ("vgl", "now, through VirtualGL on the NVIDIA GPU", NOW, "vgl", "max", ["idle", "scroll", "status"]),
    ("nxvgl", "now, through NoMachine's VirtualGL", NOW, "nxvgl", "max", ["scroll"]),
]

# Settings that change how text looks, carried over from your running Herdr.
LOOK = ["HERDR_VTE_COMPAT", "HERDR_FONT_HINTING", "ZED_FONTS_GAMMA", "ZED_FONTS_GRAYSCALE_ENHANCED_CONTRAST",
        "ZED_FONTS_SUBPIXEL_ENHANCED_CONTRAST", "GPUI_X11_SCALE_FACTOR"]
# Left out of the test windows' environment: each setup sets its own.
SCRUB = ("HC_", "HERDR_", "VGL", "LP_", "WGPU_", "GALLIUM_", "LIBGL_", "MESA_", "__GLX_", "__EGL_", "__GL_", "ZED_",
         "GPUI_")


def say(msg):
    print(f"cpu_check: {msg}", file=sys.stderr, flush=True)


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    except OSError:
        return None


def environ_of(pid):
    out = {}
    for item in (read(f"/proc/{pid}/environ") or "").split("\0"):
        k, _, v = item.partition("=")
        if k:
            out[k] = v
    return out


def ticks(path):
    s = read(path)
    if not s:
        return None
    rest = s[s.rfind(")") + 2:].split()
    try:
        return int(rest[11]) + int(rest[12])
    except (IndexError, ValueError):
        return None


class Cleaner:
    """Every string read from the system passes through this before the report:
    printable ASCII, paths cut to file names, home, user and host names out."""

    def __init__(self):
        pw = pwd.getpwuid(os.getuid())
        self.homes = [h for h in {pw.pw_dir, os.path.expanduser("~")} if h and h != "/"]
        host = socket.gethostname()
        words = {pw.pw_name, os.environ.get("USER", ""), host, host.split(".")[0]}
        self.words = [re.compile(r"(?<![A-Za-z0-9])" + re.escape(w) + r"(?![A-Za-z0-9])", re.I)
                      for w in words if len(w) >= 3 and w != "root" and not w.startswith("localhost")]

    def __call__(self, s):
        s = "".join(c if " " <= c <= "~" else "?" for c in s)
        for h in self.homes:
            s = s.replace(h, "~")
        # Paths (after a space, quote, = or the start) to their file names; GPU names such
        # as "RTX 4070/PCIe/SSE2" keep their slashes.
        s = re.sub(r"(?:(?<=[\s'\"=(:])|^)~?(?:/[^\s/:'\"()]+)+/([^\s/:'\"()]+)", r"\1", s)
        for p in self.words:
            s = p.sub("<name>", s)
        return s


def screen():
    """(width, height) of the X screen in pixels, and the scale GPUI will use."""
    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        return None
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]
    d = x.XOpenDisplay(None)
    if not d:
        return None
    x.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x.XDisplayWidth.argtypes = x.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x.XResourceManagerString.restype = ctypes.c_char_p
    x.XResourceManagerString.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    n = x.XDefaultScreen(d)
    w, h = x.XDisplayWidth(d, n), x.XDisplayHeight(d, n)
    m = re.search(rb"Xft\.dpi:\s*([0-9.]+)", x.XResourceManagerString(d) or b"")
    x.XCloseDisplay(d)
    scale = float(m.group(1)) / 96 if m else 1.0
    return w, h, scale


def real_app():
    """Your running Herdr window process (most threads), if any."""
    best = None
    for e in os.scandir("/proc"):
        if not e.name.isdigit() or (read(f"/proc/{e.name}/comm") or "").strip() != "herdr-app":
            continue
        try:
            if os.stat(f"/proc/{e.name}").st_uid != os.getuid():
                continue
            n = len(os.listdir(f"/proc/{e.name}/task"))
        except OSError:
            continue
        if best is None or n > best[1]:
            best = (int(e.name), n)
    return best[0] if best else None


def find_vgl():
    upstream = nx = None
    for p in [shutil.which("vglrun"), "/opt/VirtualGL/bin/vglrun", "/usr/bin/vglrun"]:
        if p and os.path.isfile(p):
            if p.startswith("/usr/NX/"):
                nx = nx or p
            else:
                upstream = upstream or p
    for p in sorted(glob.glob("/usr/NX/**/vglrun", recursive=True)):
        nx = nx or p
    version = None
    for cmd in (["dpkg-query", "-W", "-f", "${Version}", "virtualgl"], ["rpm", "-q", "--qf", "%{VERSION}", "VirtualGL"]):
        if shutil.which(cmd[0]):
            r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
            if r.returncode == 0 and r.stdout.strip():
                version = r.stdout.strip()
                break
    return upstream, version, nx


def nvidia_device():
    for card in sorted(glob.glob("/sys/class/drm/card*")):
        name = os.path.basename(card)
        if re.fullmatch(r"card\d+", name) and (read(f"{card}/device/vendor") or "").strip() == "0x10de":
            dev = f"/dev/dri/{name}"
            return dev, os.access(dev, os.R_OK | os.W_OK)
    return None, False


def find_hc():
    for p in [shutil.which("hc"), os.path.expanduser("~/.local/bin/hc"), "/usr/local/bin/hc",
              os.path.expanduser("~/.cargo/bin/hc")]:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            r = subprocess.run([p, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
            if r.returncode == 0 and r.stdout.startswith("hc "):
                return p
    return None


RUST_HASH = re.compile(r"::h[0-9a-f]{16}\b")
RUST_CRATE_HASH = re.compile(r"(?<=[A-Za-z0-9_])\[[0-9a-f]{4,16}\](?=::|>|,|$)")
# Frames every main-thread stack passes through: left out of the perf summary.
TRUNK = re.compile(
    r"^(_start|main|__libc_start_main.*|__libc_start_call_main|std::rt::.*|std::sys::.*|std::panicking::.*|"
    r"std::panic::.*|core::ops::function::.*|__rust_try|.*__rust_begin_short_backtrace.*|herdr_app::main)$")


def find_perf():
    """A perf that runs (Ubuntu's /usr/bin/perf refuses without a matching linux-tools)."""
    cands = [shutil.which("perf")] + sorted(glob.glob("/usr/lib/linux-tools*/perf") +
                                            glob.glob("/usr/lib/linux-tools/*/perf"), reverse=True)
    for c in cands:
        if not c:
            continue
        try:
            r = subprocess.run([c, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if r.returncode == 0 and r.stdout.startswith(b"perf version"):
            return c
    return None


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


class Stacks:
    """perf's samples of one thread, kept only as counts of function and library
    names (perf's raw data, which holds stack memory, is deleted with the rest)."""

    HEADER = re.compile(r"^\s*(.*?)\s+(\d+)/(\d+)\s*$")
    FRAME = re.compile(r"^\s+([0-9a-fA-F]+)\s+(.*)$")

    def __init__(self, clean):
        self.clean, self.total, self.cache = clean, 0, {}
        self.incl, self.self_ = {}, {}

    def frame(self, sym, dso):
        hit = self.cache.get((sym, dso))
        if hit is None:
            sym = re.sub(r"\+0x[0-9a-fA-F]+$", "", sym.strip())
            lib = dso.strip()
            lib = "[kernel]" if lib.startswith("[kernel") else lib.replace(" (deleted)", "").rstrip("/").rsplit("/", 1)[-1]
            lib = self.clean(lib)[:40] or "?"
            hit = self.cache[(sym, dso)] = (sym if sym and sym != "[unknown]" else f"[{lib}]", lib)
        return hit

    def add(self, frames):
        if not frames:
            return
        self.total += 1
        self.self_[frames[0]] = self.self_.get(frames[0], 0) + 1
        for name in {f[0] for f in frames}:
            self.incl[name] = self.incl.get(name, 0) + 1

    def read(self, stream):
        cur = None
        for line in stream:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            if line[0] in " \t":
                m = self.FRAME.match(line)
                if m and cur is not None:
                    cur.append(self.frame(*split_frame(m.group(2))))
            elif self.HEADER.match(line):
                self.add(cur or [])
                cur = []
        self.add(cur or [])

    def finish(self):
        """Names perf left mangled (Rust v0, C++) through binutils' c++filt, then cleaned."""
        names = set(self.incl) | {n for n, _ in self.self_}
        todo = sorted(n for n in names if n.startswith(("_R", "_ZN")))
        mapping = {}
        if todo and shutil.which("c++filt"):
            try:
                r = subprocess.run(["c++filt"], input="\n".join(todo) + "\n", stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, universal_newlines=True, timeout=120)
                out = r.stdout.splitlines()
                if r.returncode == 0 and len(out) == len(todo):
                    mapping = dict(zip(todo, out))
            except (OSError, subprocess.SubprocessError):
                pass

        def fix(n):
            n = self.clean(RUST_CRATE_HASH.sub("", RUST_HASH.sub("", mapping.get(n, n))))
            return n if len(n) <= 130 else n[:127] + "..."

        incl, self_ = {}, {}
        for n, c in self.incl.items():
            incl[fix(n)] = incl.get(fix(n), 0) + c
        for (n, lib), c in self.self_.items():
            self_[(fix(n), lib)] = self_.get((fix(n), lib), 0) + c
        self.incl, self.self_ = incl, self_


class Run:
    """One test window: its own home, the shared test core, its own log."""

    def __init__(self, ctx, setup):
        self.ctx, (self.name, self.what, self.vars, self.wrap, self.window, self.scenarios) = ctx, setup
        self.home = os.path.join(ctx.root, f"home-{self.name}")
        self.proc = None
        self.perf_proc = None
        self.pid = None
        self.rows = {}
        self.info = {}

    def env(self):
        c = self.ctx
        e = {k: v for k, v in os.environ.items() if not k.startswith(SCRUB)}
        if any(s in e.get("LD_PRELOAD", "") for s in ("vgl", "faker", "/NX/")):
            e.pop("LD_PRELOAD")
        for k in ("WAYLAND_DISPLAY", "WAYLAND_SOCKET"):
            e.pop(k, None)
        e.update(c.look)
        e.update(self.vars)
        e.update(HERDR_APP_HOME=self.home, HC_SESSION=c.session, XDG_STATE_HOME=os.path.join(c.root, "state"),
                 HERDR_APP_NO_SOUND="1", HERDR_TELEMETRY="0", HERDR_APP_BENCH=os.path.join(self.home, "frames.jsonl"),
                 HERDR_APP_LOG="warn,herdr_app=info,gpui_wgpu=info,gpui_linux=info",
                 PATH=os.path.dirname(c.hc) + os.pathsep + e.get("PATH", ""))
        return e

    def prepare(self):
        c = self.ctx
        os.makedirs(self.home)
        for name in ("settings.json",):
            src = os.path.join(c.real_home, name)
            if os.path.isfile(src):
                shutil.copy(src, self.home)
        for name in ("themes", "fonts"):
            src = os.path.join(c.real_home, name)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(self.home, name))
        if not os.path.exists(os.path.join(self.home, "settings.json")):
            with open(os.path.join(self.home, "settings.json"), "w") as f:
                f.write("{}\n")
        with open(os.path.join(self.home, "shared.json"), "w") as f:
            json.dump({"frame.welcomed": True, "layout": "main"}, f)
        w, h, scale = c.screen or (1920, 1080, 1.0)
        lw, lh = w / scale, h / scale
        place = ({"state": "windowed", "bounds": [0, 0, round(lw / 2), round(lh / 2)]} if self.window == "quarter"
                 else {"state": "maximized", "bounds": [0, 0, round(lw * 0.6), round(lh * 0.6)]})
        with open(os.path.join(self.home, "window.json"), "w") as f:
            json.dump(place, f)

    def do(self, command, args=None):
        cmd = [self.ctx.bin, "do", command] + ([json.dumps(args)] if args else [])
        for _ in range(50):
            r = subprocess.run(cmd, env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            if r.returncode == 0 or "unavailable" not in r.stdout + r.stderr:
                break
            time.sleep(0.2)
        if r.returncode != 0:
            raise RuntimeError(f"{command} failed")

    def start(self):
        c = self.ctx
        wrap = []
        if self.wrap == "vgl":
            wrap = [c.vgl, "-d", c.nvidia or "egl"]
        elif self.wrap == "nxvgl":
            wrap = [c.nxvgl]
        self.log = open(os.path.join(self.home, "app.log"), "w")
        self.proc = subprocess.Popen(wrap + [c.bin], env=self.env(), stdin=subprocess.DEVNULL, stdout=self.log,
                                     stderr=self.log, start_new_session=True)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                return False
            try:
                if subprocess.run([c.bin, "status"], env=self.env(), stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL, timeout=3).returncode == 0:
                    break
            except subprocess.TimeoutExpired:
                pass
            time.sleep(0.3)
        else:
            return False
        # The window process itself (a wrapper may sit in between).
        for e in os.scandir("/proc"):
            if e.name.isdigit() and (read(f"/proc/{e.name}/comm") or "").strip() == "herdr-app":
                if environ_of(e.name).get("HERDR_APP_HOME") == self.home and len(os.listdir(f"/proc/{e.name}/task")) > 3:
                    self.pid = int(e.name)
        return self.pid is not None

    def stop(self):
        if self.perf_proc and self.perf_proc.poll() is None:
            try:
                os.killpg(self.perf_proc.pid, signal.SIGKILL)
            except OSError:
                pass
            self.perf_proc.wait()
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                self.proc.wait()
        if getattr(self, "log", None):
            self.log.close()

    def snapshot(self):
        threads = {}
        try:
            tids = os.listdir(f"/proc/{self.pid}/task")
        except OSError:
            return None
        for tid in tids:
            t = ticks(f"/proc/{self.pid}/task/{tid}/stat")
            if t is not None:
                threads[int(tid)] = ((read(f"/proc/{self.pid}/task/{tid}/comm") or "").strip(), t)
        core = 0
        r = subprocess.run([self.ctx.hc, "server", "status", "--json"], env=self.env(), stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, universal_newlines=True)
        try:
            s = json.loads(r.stdout or "{}")
            for p in [s.get("pid")] + [h.get("pid") for h in s.get("holders", [])]:
                core += (ticks(f"/proc/{p}/stat") or 0) if p else 0
        except (ValueError, AttributeError):
            pass
        frames = read(os.path.join(self.home, "frames.jsonl")) or ""
        return {"t": time.monotonic(), "app": ticks(f"/proc/{self.pid}/stat"), "threads": threads, "core": core,
                "frames": len(frames.splitlines())}

    def measure(self, scenario):
        time.sleep(SETTLE)
        c = self.ctx
        raw = os.path.join(c.root, "perf.data")
        if c.perf and (self.name, scenario) == PERF_AT:
            # The main thread only (its id is the process id).
            self.perf_proc = subprocess.Popen(
                [c.perf, "record", "-q", "-N", "-o", raw, "-t", str(self.pid),
                 "-e", "cpu-clock" if os.geteuid() == 0 else "cpu-clock:u", "-c", "2000000",
                 "--call-graph", "dwarf,16384", "--", "sleep", str(c.seconds)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        a = self.snapshot()
        time.sleep(c.seconds)
        b = self.snapshot()
        if self.perf_proc:
            try:
                self.perf_proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(self.perf_proc.pid, signal.SIGINT)
                self.perf_proc.wait()
            self.perf_proc = None
            if os.path.exists(raw) and os.path.getsize(raw) > 0:
                say(f"  {self.name}: reading the main thread's perf samples")
                stacks = Stacks(c.clean)
                p = subprocess.Popen([c.perf, "script", "-i", raw, "-F", "comm,pid,tid,ip,sym,dso", "--no-inline"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
                stacks.read(line.decode("utf-8", "replace") for line in p.stdout)
                p.wait()
                stacks.finish()
                c.stacks = stacks if stacks.total else None
                os.remove(raw)
        if a is None or b is None or a["app"] is None or b["app"] is None:
            self.rows[scenario] = None
            return
        dt = b["t"] - a["t"]
        pct = lambda n: 100.0 * n / CLK / dt
        llvm = main = 0
        llvm_threads = 0
        groups = {}
        for tid, (comm, t) in b["threads"].items():
            used = t - a["threads"].get(tid, (comm, 0))[1]
            group = "main" if tid == self.pid else re.sub(r"\d+", "N", c.clean(comm)) or "?"
            groups[group] = groups.get(group, 0) + used
            if comm.startswith("llvmpipe"):
                llvm += used
                llvm_threads += 1
            elif tid == self.pid:
                main += used
        lines = (read(os.path.join(self.home, "frames.jsonl")) or "").splitlines()[a["frames"]:b["frames"]]
        rows = []
        for l in lines:
            try:
                rows.append(json.loads(l))
            except ValueError:
                pass
        per = lambda key: sum(r.get(key, 0) for r in rows) / max(len(rows), 1)
        draws = per("window")
        app = pct(b["app"] - a["app"])
        self.rows[scenario] = {
            "app": app, "llvm": pct(llvm), "main": pct(main), "core": pct(b["core"] - a["core"]),
            "draws": draws, "llvm_threads": llvm_threads,
            "ms_draw": app * 10 / draws if draws >= 0.5 else None,
            # Main-thread milliseconds per draw, all of it and building the frame (render to paint).
            "main_draw": pct(main) * 10 / draws if draws >= 0.5 else None,
            "build": per("frame_ms") / draws if draws >= 0.5 else None,
            "term": per("terminal"), "js": per("scripts"),
            "threads": [(g, pct(n)) for g, n in sorted(groups.items(), key=lambda x: -x[1])[:3] if n],
        }

    def play(self):
        c = self.ctx
        self.do("space.new", {"name": "cpu-check", "folder": c.root})
        for scenario in self.scenarios:
            say(f"  {self.name}: {scenario}")
            secs = str(SETTLE + c.seconds + 2)
            if scenario == "idle":
                pass
            elif scenario == "hidden":
                self.do("tab.new", {"name": "hidden", "argv": [sys.executable, "-u", c.gen, "scroll", secs]})
                self.do("tab.select", {"index": 1})
            else:
                self.do("tab.new", {"name": scenario, "argv": [sys.executable, "-u", c.gen, scenario, secs]})
            self.measure(scenario)

    def read_log(self):
        clean = self.ctx.clean
        text = re.sub(r"\x1b\[[0-9;]*m", "", read(os.path.join(self.home, "app.log")) or "")
        adapters, failed = [], []
        selected = scale = present = modes = None
        partial = False
        for line in text.splitlines():
            m = re.search(r"  - (.+?) \(vendor=0x[0-9a-f]+, device=0x[0-9a-f]+, backend=(\w+), type=(\w+)\)", line)
            if m:
                adapters.append(f"{clean(m.group(1))} [{m.group(2)}, {m.group(3)}]")
            m = re.search(r"Selected GPU \(passed configuration test\): (.+) \((\w+)\)\s*$", line)
            if m:
                selected = f"{clean(m.group(1))} [{m.group(2)}]"
            m = re.search(r"Adapter (.+?) \((\w+)\) failed: (.*?), trying next", line)
            if m:
                failed.append(f"{clean(m.group(1))} [{m.group(2)}]: {clean(m.group(3))[:110]}")
            m = re.search(r"[Ss]cale factor[^:]*: ([0-9.]+)", line)
            if m:
                scale = m.group(1)
            partial = partial or "partial redraw enabled" in line
            m = re.search(r"\[HERDR_LATENCY_EXPERIMENT\] requested=\S+ chosen=(\w+) available=\[([^\]]*)\]", line)
            if m:
                present, modes = m.group(1), m.group(2).replace(" ", "")
        errors = [clean(l.strip())[:150] for l in text.splitlines() if re.search(r"panicked|ERROR|error:", l)][:3]
        maps = read(f"/proc/{self.pid}/maps") if self.pid else ""
        self.info = {"adapters": adapters, "selected": selected, "failed": failed, "scale": scale,
                     "partial": partial, "errors": errors, "present": present, "modes": modes,
                     "vgl_loaded": bool(maps and re.search(r"vglfaker|libvgl", maps))}


class Ctx:
    pass


def fmt(v, digits=0):
    return "-" if v is None else f"{v:.{digits}f}"


def report(ctx, runs, skipped):
    L = []
    w = L.append
    w("herdr-app CPU check (paste this whole block back)")
    sc = ctx.screen
    w(f"machine: {os.cpu_count()} CPUs; screen {sc[0]}x{sc[1]} px, Xft scale {sc[2]:g}" if sc else
      f"machine: {os.cpu_count()} CPUs; screen size unknown")
    w(f"binary: {ctx.version} ({ctx.bin_from}); look: " + (", ".join(f"{k}={v}" for k, v in ctx.look.items()) or "defaults"))
    w(f"NVIDIA DRI device: {('yes, usable' if ctx.nvidia_ok else 'yes, NOT accessible to you') if ctx.nvidia else 'none'}; "
      f"VirtualGL: {('installed ' + (ctx.vgl_version or 'version unknown')) if ctx.vgl else 'not installed'}; "
      f"NoMachine VirtualGL: {'present' if ctx.nxvgl else 'none'}")
    w(f"draw cap (HERDR_MAX_FPS) in this binary: {'yes' if ctx.has_cap else 'no (build the branch with it to test gpu-30/gpu-20)'}; "
      f"perf: {ctx.perf_note}")
    if ctx.preload_dropped:
        w("note: a VirtualGL/NoMachine LD_PRELOAD in this shell was left out of the test windows")
    adapters = []
    for r in runs:
        for a in r.info.get("adapters", []):
            if a not in adapters:
                adapters.append(a)
    w("adapters found: " + ("; ".join(adapters) or "-"))
    w("")
    head = (f"{'setup':11} {'scenario':8} {'app%':>6} {'llvmpipe%':>9} {'main%':>6} {'draws/s':>7} {'ms/draw':>7} "
            f"{'build':>6} {'term/s':>6} {'js/s':>5}  renderer")
    w(head)
    for r in runs:
        renderer = r.info.get("selected") or "?"
        extra = []
        if r.info.get("partial"):
            extra.append("partial")
        if r.wrap:
            extra.append("VirtualGL " + ("active" if r.info.get("vgl_loaded") else "NOT loaded"))
        if r.info.get("scale"):
            extra.append(f"scale {r.info['scale']}")
        if r.info.get("present"):
            extra.append(f"present {r.info['present']} (of {r.info.get('modes')})")
        if not r.rows:
            w(f"{r.name:10} {'-':8} did not start" + (": " + " | ".join(r.info.get("errors", [])) if r.info.get("errors") else ""))
            continue
        first = True
        for s, row in r.rows.items():
            if row is None:
                w(f"{r.name:10} {s:8} (the test window went away)")
                continue
            note = ""
            if first:
                threads = max(x["llvm_threads"] for x in r.rows.values() if x)
                note = renderer + (" + " + ", ".join(extra) if extra else "") + (f", {threads} llvmpipe threads" if threads else "")
            first = False
            w(f"{r.name:11} {s:8} {row['app']:6.0f} {row['llvm']:9.0f} {row['main']:6.0f} "
              f"{row['draws']:7.1f} {fmt(row['ms_draw']):>7} {fmt(row.get('build'), 1):>6} "
              f"{row.get('term', 0):6.1f} {row.get('js', 0):5.1f}  {note}")
            if s in ("idle", "hidden") and row.get("threads"):
                w(f"{'':11} {'':8} busiest threads: " + ", ".join(f"{g} {v:.1f}%" for g, v in row["threads"]))
        for f in r.info.get("failed", []):
            w(f"{'':10} adapter failed: {f}")
    for name, why in skipped:
        w(f"{name:10} skipped: {why}")
    w("")
    w("ms/draw = CPU ms per window draw, all threads; build = main-thread ms per draw building it (render to paint);")
    w("term/s = terminal renders a second; js/s = mod script renders a second")
    w("")
    st = getattr(ctx, "stacks", None)
    if st:
        w(f"Main thread while {PERF_AT[0]} {PERF_AT[1]}s (perf, {st.total} samples, each 2 ms of its CPU time)")
        w("  inclusive (the function and all it calls):")
        shown = [(n, c) for n, c in sorted(st.incl.items(), key=lambda x: -x[1])
                 if c < st.total * 0.995 and not TRUNK.match(n)][:24]
        for n, c in shown:
            w(f"  {100 * c / st.total:5.1f}  {n}")
        w("  self (time in the function itself):")
        for (n, lib), c in sorted(st.self_.items(), key=lambda x: -x[1])[:12]:
            w(f"  {100 * c / st.total:5.1f}  {n[:100]}  [{lib}]")
        w("")

    def row(setup, scenario):
        for r in runs:
            if r.name == setup:
                return r.rows.get(scenario)
        return None

    def verdict(tag, ok, text):
        if ok is not None:
            w(f"  {tag:4} {'CONFIRMED ' if ok else 'REFUTED   '} {text}")

    w("Hypotheses (only those this run tested)")
    g = row("gpu", "scroll")
    if g and any(r.name.startswith("cap") or r.name in ("gpu-imm", "gpu-mailbox", "gpu-yield") for r in runs):
        verdict("S1", g["draws"] <= 33,
                f"one printing terminal draws at most ~30 times a second (the output clock fix): {g['draws']:.0f} draws/s")
        for tag, name, what in (("S2", "gpu-imm", "Immediate present"), ("S3", "gpu-mailbox", "Mailbox present"),
                                ("S4", "gpu-yield", "__GL_YIELD=USLEEP")):
            x = row(name, "scroll")
            run = next((r for r in runs if r.name == name), None)
            if x and g["ms_draw"] and x["ms_draw"] and run:
                mode = run.info.get("present")
                fell_back = name != "gpu-yield" and mode and mode.lower() != what.split()[0].lower()
                verdict(tag, x["ms_draw"] <= 0.75 * g["ms_draw"],
                        f"{what} costs less CPU per draw than Fifo: {x['ms_draw']:.1f} vs {g['ms_draw']:.1f} ms"
                        f" ({x['app']:.0f}% vs {g['app']:.0f}% scrolling)"
                        + (f"; NOTE: the driver gave {mode} instead" if fell_back else ""))
        caps = [(n, int(n[3:]), row(n, "scroll")) for n in ("cap30", "cap20", "cap15", "cap10")]
        caps = [(n, fps, x) for n, fps, x in caps if x]
        if caps:
            verdict("S5", all(abs(x["draws"] - min(fps, g["draws"])) <= 0.15 * fps for _, fps, x in caps),
                    "the draw cap holds its rate, and CPU follows it: "
                    + ", ".join(f"cap {fps}: {x['app']:.0f}% at {x['draws']:.0f}/s" for _, fps, x in caps)
                    + f" (no cap: {g['app']:.0f}% at {g['draws']:.0f}/s)")
        gi, gh = row("gpu", "idle"), row("gpu", "hidden")
        if gi and gh:
            verdict("S6", gi["app"] < 2 and gh["app"] < 3,
                    f"nothing on screen changing costs ~nothing: idle {gi['app']:.1f}%, output in a hidden tab {gh['app']:.1f}%")
    gl = row("gl", "scroll")
    gpu = next((r for r in runs if r.name == "gpu"), None)
    if not any(r.name in ("gl", "gpu-30", "gpu-20") for r in runs):
        gpu = g = None  # round 2's verdicts, only when its setups ran
    if g and gpu:
        sel = gpu.info.get("selected") or ""
        verdict("R1", g["llvm"] <= max(5, 0.05 * g["app"]) and bool(sel) and not SOFTWARE.search(sel),
                f"with no backend forced, the GPU draws: {sel or '?'}, llvmpipe {g['llvm']:.0f}% of {g['app']:.0f}%")
    if g and gl:
        verdict("R2", g["app"] <= 0.15 * gl["app"],
                f"scrolling on the GPU costs a small fraction of OpenGL on llvmpipe: {g['app']:.0f}% vs {gl['app']:.0f}%")
    gi, gh = row("gpu", "idle"), row("gpu", "hidden")
    if g and gi and gh:
        verdict("R3", gi["app"] < 3 and gh["app"] < 5,
                f"on the GPU, nothing printing and output in a hidden tab cost ~nothing: {gi['app']:.1f}% and {gh['app']:.1f}%")
    if g:
        verdict("R4", g["draws"] <= 33,
                f"scrolling draws at most ~30 times a second (the terminal's output clock): {g['draws']:.0f} draws/s,"
                f" {g['term']:.0f} terminal renders/s, {g['js']:.0f} mod script renders/s")
    g30, g20 = row("gpu-30", "scroll"), row("gpu-20", "scroll")
    if g and (g30 or g20) and ctx.has_cap:
        best = min(x["app"] for x in (g30, g20) if x)
        verdict("R5", best <= 0.75 * g["app"],
                f"capping draws cuts scrolling CPU: {g['app']:.0f}% at {g['draws']:.0f}/s"
                + (f", {g30['app']:.0f}% at {g30['draws']:.0f}/s (cap 30)" if g30 else "")
                + (f", {g20['app']:.0f}% at {g20['draws']:.0f}/s (cap 20)" if g20 else ""))
    if g and g["main_draw"] and g["build"] is not None:
        verdict("R6", g["build"] >= 0.6 * g["main_draw"],
                f"most of the main thread's time per draw is building the frame, not presenting it:"
                f" {g['build']:.1f} of {g['main_draw']:.1f} ms")
    s = row("now", "scroll")
    verdict("H1", None if not s else s["llvm"] >= 0.7 * s["app"],
            "the CPU goes to the software rasterizer (llvmpipe threads)"
            + (f": {100 * s['llvm'] / s['app']:.0f}% of {s['app']:.0f}%" if s and s["app"] else ""))
    verdict("H2", None if not s else s["main"] <= 30,
            "herdr-app's own work (main thread) is small" + (f": {s['main']:.0f}% while scrolling" if s else ""))
    i = row("now", "idle")
    verdict("H3", None if not i else i["app"] < 3, "nothing printing costs ~nothing" + (f": {i['app']:.1f}%" if i else ""))
    h = row("now", "hidden")
    verdict("H4", None if not h else h["app"] < 10,
            "output in a tab you don't see costs ~nothing" + (f": {h['app']:.1f}%" if h else ""))
    b = row("now", "burst10")
    ok = None
    if s and b and s["ms_draw"] and b["ms_draw"]:
        ok = 0.65 <= b["ms_draw"] / s["ms_draw"] <= 1.5
    verdict("H5", ok, "CPU is per draw, so fewer draws cost proportionally less"
            + (f": {s['ms_draw']:.0f} vs {b['ms_draw']:.0f} ms/draw; at 10 draws/s scrolling would cost"
               f" ~{s['ms_draw'] * 10 / 10:.0f}% instead of {s['app']:.0f}%" if ok is not None else ""))
    q = row("quarter", "scroll")
    ok = None
    if s and q and s["ms_draw"] and q["ms_draw"]:
        ok = q["ms_draw"] / s["ms_draw"] <= 0.55
    verdict("H6", ok, "CPU per draw grows with the window's pixels"
            + (f": quarter window {q['ms_draw']:.0f} vs maximized {s['ms_draw']:.0f} ms/draw" if ok is not None else ""))
    st, nst = row("now", "status"), row("nopartial", "status")
    ok = None
    if st and nst and st["ms_draw"] and nst["ms_draw"]:
        ok = st["ms_draw"] / nst["ms_draw"] <= 0.5
    verdict("H7", ok, "partial redraw makes one changing line cheap"
            + (f": {st['ms_draw']:.0f} vs {nst['ms_draw']:.0f} ms/draw without it" if ok is not None else ""))
    l4 = row("lp4", "scroll")
    verdict("H8", None if not (l4 and s) else l4["app"] <= 480,
            "LP_NUM_THREADS=4 caps herdr-app near 400%"
            + (f": {l4['app']:.0f}% at {l4['draws']:.0f} draws/s (vs {s['app']:.0f}% at {s['draws']:.0f})" if l4 and s else ""))
    a = row("auto", "scroll")
    auto = next((r for r in runs if r.name == "auto"), None)
    ok = None
    if a and auto:
        selected = auto.info.get("selected") or ""
        # wgpu starts llvmpipe threads while it probes the software adapters; idle ones don't count.
        ok = a["llvm"] <= max(5, 0.05 * a["app"]) and bool(selected) and not SOFTWARE.search(selected)
    verdict("H9", ok, "the GPU works without VirtualGL (Vulkan or GL picked on their own)"
            + (f": picked {auto.info.get('selected')}, {a['app']:.0f}% while scrolling" if a and auto else ""))
    for name, tag in (("vgl", "H10"), ("nxvgl", "H11")):
        v = row(name, "scroll")
        run = next((r for r in runs if r.name == name), None)
        ok = None
        if v and s:
            selected = run.info.get("selected") or ""
            ok = (v["llvm"] <= max(5, 0.05 * v["app"]) and not SOFTWARE.search(selected)
                  and v["app"] <= max(0.25 * s["app"], 30))
        label = "VirtualGL on the NVIDIA GPU" if name == "vgl" else "NoMachine's VirtualGL"
        verdict(tag, ok, f"{label} takes the drawing off the CPU"
                + (f": {v['app']:.0f}% vs {s['app']:.0f}% while scrolling, renderer {run.info.get('selected')}" if v and s and run else ""))
    scrolls = [(r.rows["scroll"]["app"], r.name) for r in runs if r.rows.get("scroll")]
    if scrolls:
        best = min(scrolls)
        w(f"Lowest CPU while scrolling: {best[1]} ({best[0]:.0f}%)")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=12, help="measured seconds per scenario (default 12)")
    ap.add_argument("--only", help="comma-separated setups to run, e.g. now,vgl")
    ap.add_argument("--bin", help="herdr-app binary to test (default: the one your running Herdr uses)")
    ap.add_argument("--keep", action="store_true", help="keep the test homes and logs (for you only)")
    args = ap.parse_args()
    if not sys.platform.startswith("linux"):
        sys.exit("cpu_check: Linux only")
    ctx = Ctx()
    ctx.seconds = args.seconds
    ctx.clean = Cleaner()
    ctx.screen = screen()

    real = real_app()
    real_env = environ_of(real) if real else {}
    if args.bin:
        ctx.bin, ctx.bin_from = os.path.abspath(args.bin), "--bin"
    else:
        exe = ""
        if real:
            try:
                exe = os.readlink(f"/proc/{real}/exe")
            except OSError:
                pass
        exe = exe[: -len(" (deleted)")] if exe.endswith(" (deleted)") else exe
        if exe and os.path.isfile(exe):
            ctx.bin, ctx.bin_from = exe, "the binary your Herdr runs" + (", rebuilt since it started" if real and
                                                                           os.readlink(f"/proc/{real}/exe").endswith(" (deleted)") else "")
        else:
            ctx.bin, ctx.bin_from = os.path.join(HERE, "..", "target", "release", "herdr-app"), "this checkout's release build"
    if not (os.path.isfile(ctx.bin) and os.access(ctx.bin, os.X_OK)):
        sys.exit("cpu_check: no herdr-app binary found; pass --bin")
    r = subprocess.run([ctx.bin, "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True)
    ctx.version = ctx.clean(r.stdout.strip())[:40] or "?"
    ctx.hc = find_hc()
    if not ctx.hc:
        sys.exit("cpu_check: herdr-core (hc) not found on PATH or in ~/.local/bin")
    ctx.real_home = real_env.get("HERDR_APP_HOME") or os.path.join(
        real_env.get("XDG_CONFIG_HOME") or os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "herdr-app")
    look_src = real_env or os.environ
    ctx.look = {k: look_src[k] for k in LOOK if k in look_src}
    ctx.preload_dropped = any(s in os.environ.get("LD_PRELOAD", "") for s in ("vgl", "faker", "/NX/"))
    ctx.vgl, ctx.vgl_version, ctx.nxvgl = find_vgl()
    ctx.nvidia, ctx.nvidia_ok = nvidia_device()
    with open(ctx.bin, "rb") as f:
        ctx.has_cap = b"HERDR_MAX_FPS" in f.read()
    ctx.stacks = None
    ctx.perf = find_perf()
    paranoid = (read("/proc/sys/kernel/perf_event_paranoid") or "2").strip()
    if not ctx.perf:
        ctx.perf_note = "not installed (no main-thread breakdown)"
    elif os.geteuid() != 0 and not (paranoid.lstrip("-").isdigit() and int(paranoid) <= 2):
        ctx.perf, ctx.perf_note = None, f"not allowed (kernel.perf_event_paranoid={paranoid})"
    else:
        ctx.perf_note = f"samples the main thread during {PERF_AT[0]} {PERF_AT[1]}"

    wanted = set(args.only.split(",")) if args.only else set(DEFAULT)
    setups, skipped = [], []
    for s in SETUPS:
        if wanted and s[0] not in wanted:
            continue
        if s[3] == "vgl" and not ctx.vgl:
            skipped.append((s[0], "VirtualGL not installed (3.1 or later: github.com/VirtualGL/virtualgl/releases)"))
        elif s[3] == "vgl" and ctx.nvidia and not ctx.nvidia_ok:
            skipped.append((s[0], "the NVIDIA DRI device isn't accessible to you (add yourself to its group, e.g. video/render)"))
        elif s[3] == "nxvgl" and not ctx.nxvgl:
            skipped.append((s[0], "no vglrun in NoMachine's folder"))
        else:
            setups.append(s)

    ctx.root = tempfile.mkdtemp(prefix="herdr-cpu-check-", dir="/var/tmp" if os.path.isdir("/var/tmp") else None)
    os.chmod(ctx.root, 0o700)
    ctx.session = "hcpu" + os.path.basename(ctx.root)[-6:]
    ctx.gen = os.path.join(ctx.root, "output.py")
    with open(ctx.gen, "w") as f:
        f.write(GEN)
    minutes = sum(len(s[5]) * (SETTLE + args.seconds + 1) + 8 for s in setups) / 60
    say(f"{len(setups)} setups, about {minutes:.0f} minutes; keep the test window on screen")
    runs = []
    probe = Run(ctx, setups[0]) if setups else None
    try:
        if probe:
            probe.prepare()
        r = subprocess.run([ctx.hc, "server", "start"], env=probe.env() if probe else os.environ,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        if r.returncode:
            sys.exit("cpu_check: the test core didn't start")
        for i, s in enumerate(setups):
            run = probe if i == 0 else Run(ctx, s)
            if i:
                run.prepare()
            runs.append(run)
            say(f"{run.name}: {run.what}")
            try:
                if run.start():
                    run.play()
                else:
                    say(f"{run.name}: the test window didn't come up")
            except RuntimeError as e:
                say(f"{run.name}: {e}")
            finally:
                run.read_log()
                run.stop()
                end_terminals(ctx, run)
    except KeyboardInterrupt:
        say("stopped; reporting what ran")
    finally:
        for run in runs:
            run.stop()
        env = probe.env() if probe else None
        if env:
            subprocess.run([ctx.hc, "server", "stop"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        text = report(ctx, runs, skipped) if runs or skipped else ""
        if args.keep:
            say(f"test homes and logs kept (for you only): {ctx.root}")
        else:
            shutil.rmtree(ctx.root, ignore_errors=True)
    if text:
        out = f"herdr-cpu-check-{time.strftime('%Y%m%d-%H%M%S')}.txt"
        with open(out, "w") as f:
            f.write(text)
        print(text)
        say(f"saved as {os.path.abspath(out)}")


def end_terminals(ctx, run):
    """The test core's terminals outlive the window: end them before the next setup."""
    env = run.env()
    r = subprocess.run([ctx.hc, "ls", "--json"], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       universal_newlines=True)
    try:
        terminals = json.loads(r.stdout or "{}").get("terminals", [])
    except ValueError:
        terminals = []
    for t in terminals:
        subprocess.run([ctx.hc, "kill", t["address"]], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
