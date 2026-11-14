#!/usr/bin/env python3
"""Checks the agents mod's conversation window in Herdr's own engine.

    personal/tools/agents-mod-test/check.py                  the fixture cases (below)
    personal/tools/agents-mod-test/check.py --real t1g t1h   what the window makes of real finished runs
        --as vm       as Herdr sees them from another computer: addressed vm/t1g, their
                      logs read through `hc exec` (which is how a mod reaches a machine)
        --together    as one conversation (a first run and its follow-ups)

Needs python3 and herdr-app (any build: the mod's files come from this checkout), and
for --real or --as a running herdr-core. No node.

How: `herdr-app check` loads driver.js with the mod's thread.js, conversation.js and
util.js beside it. The mod's steps (find the session, read the log, ...) ask for
commands; the engine can't wait for them, so the driver throws what it needs, this
script runs it (the same `sh -c` the app would run, on the fixture homes or the real
ones) and asks again until every case is through. Then each case's rounds are compared
with what the fixtures hold, and each conversation is rendered for real, folded and
with every fold open: an element method the engine doesn't know fails the check.
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import fixtures

HERE = os.path.dirname(os.path.abspath(__file__))
MOD = os.path.normpath(os.path.join(HERE, "../../../defaults/mods/agents"))
CODEX = {"key": "codex", "name": "Codex", "icon": "icons/codex.svg", "tint": True}
KIMI = {"key": "kimi", "name": "Kimi", "icon": "icons/kimi.svg", "tint": False}
failed = 0


def check(ok, what, got=None):
    global failed
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failed += 1
        if got is not None:
            print("     got: " + json.dumps(got)[:1500])


def engine(folder):
    r = subprocess.run(["herdr-app", "check", folder], capture_output=True, text=True, timeout=120)
    return r.returncode == 0, r.stdout + r.stderr


def build(folder, cases, answers, mode, view=None, opened=None):
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder)
    for name in ("thread.js", "conversation.js", "util.js", "mod.json"):
        shutil.copy(os.path.join(MOD, name), folder)
    shutil.copy(os.path.join(HERE, "driver.js"), os.path.join(folder, "main.js"))
    with open(os.path.join(folder, "cases.js"), "w") as f:
        for name, value in (("CASES", cases), ("ANSWERS", answers), ("MODE", mode), ("VIEW", view), ("OPEN", opened)):
            f.write("export const %s = %s;\n" % (name, json.dumps(value)))


def local(address):
    return address.split("/")[-1]


def host(request, world):
    """Does what the app would for one request of the mod: {"value": ...} or {"error": ...}."""
    kind = request[0]
    if kind == "hc":
        args = request[1]
        if world.get("records") is not None:   # the fixtures' core
            known = world["records"].get(args[1])
            if not known:
                return {"value": {"code": 1, "stdout": "", "stderr": "no such terminal"}}
            out = known if args[0] == "get" else world["screens"][args[1]]
            return {"value": {"code": 0, "stdout": json.dumps(out), "stderr": ""}}
        # The real core. From another computer the address has the machine's name; here it has none.
        r = subprocess.run(["hc", args[0], local(args[1])] + args[2:], capture_output=True, text=True, timeout=30)
        return {"value": {"code": r.returncode, "stdout": r.stdout, "stderr": r.stderr}}
    if kind == "file":
        try:
            with open(request[1], errors="replace") as f:
                return {"value": f.read(1 << 20)}
        except OSError as e:
            return {"error": str(e)}
    script, args, on = request[1], request[2], request[3]
    if world.get("unreachable") and world["unreachable"] in args:
        return {"error": "machine %s is unreachable" % on}
    argv = ["sh", "-c", script, "sh"] + args
    env = world.get("env", {})
    if on and world.get("hc_exec"):
        # As the app reaches another machine: `hc exec`, its output as base64 in JSON, at most 8 MiB.
        cmd = ["hc", "exec", "--json", "--timeout", "30"] + [x for k, v in env.items() for x in ("--env", "%s=%s" % (k, v))] + ["--"] + argv
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        try:
            v = json.loads(r.stdout.strip() or r.stderr.strip())
        except ValueError:
            return {"error": "hc exec: " + r.stderr.strip()[:200]}
        if "error" in v:
            return {"error": v["error"].get("message", "hc exec failed")}
        text = lambda k: base64.b64decode(v.get(k) or "").decode(errors="replace")
        return {"value": {"code": v.get("code", -1), "stdout": text("stdout"), "stderr": text("stderr")}}
    r = subprocess.run(argv, capture_output=True, timeout=30, env={**os.environ, **env})
    return {"value": {"code": r.returncode, "stdout": r.stdout[: 8 << 20].decode(errors="replace"), "stderr": r.stderr.decode(errors="replace")}}


def settle(folder, cases, world):
    """Asks the engine until every case has what it asked for: (each case's report, the answers)."""
    answers = {}
    for _ in range(40):
        build(folder, cases, answers, "report")
        _, text = engine(folder)
        m = re.search(r"^(NEED|REPORT) (.*)$", text, re.M)
        if not m:
            sys.exit("the engine refused the mod:\n" + text)
        found = json.loads(m.group(2))
        if m.group(1) == "REPORT":
            return found, answers
        for request in found:
            began = time.time()
            answer = host(request, world)
            answers[json.dumps(request, separators=(",", ":"), ensure_ascii=False)] = answer
            size = len(answer["value"]["stdout"]) if isinstance(answer.get("value"), dict) else len(answer.get("value") or "")
            world.setdefault("took", []).append("%5d ms %8d bytes  %s" % ((time.time() - began) * 1000, size, " ".join([request[0]] + ([str(request[3] or "here")] + request[2][:1] if request[0] == "sh" else request[1][:2] if request[0] == "hc" else [request[1]]))))
    sys.exit("the cases never settled")


def views(folder, cases, answers, reports, which):
    for i in which:
        rounds = len(reports[i].get("rounds") or [])
        for opened in [None] + list(range(rounds)):
            build(folder, cases, answers, "view", i, opened)
            ok, text = engine(folder)
            how = "as it opens" if opened is None else "round %d with every fold open" % (opened + 1)
            check(ok, "the engine draws \"%s\", %s" % (cases[i]["name"], how), None if ok else text.strip()[:1200])


def slim(step):
    return {k: v for k, v in step.items() if k != "detail" and v is not None}


def fixture_cases(fx):
    rec = fx["records"]
    whole = lambda a, program=None: {**rec[a], "address": a, "parent": ("vm/t1" if "/" in a else "t1"), "program": program}
    # As the agents list first has a finished run: the short row of `hc ls`.
    short = lambda a, program=None: {"address": a, "name": rec[a]["name"], "parent": ("vm/t1" if "/" in a else "t1"), "state": rec[a]["state"], "program": program}
    thread = lambda name, program, addrs: {"name": name, "program": program, "asker": "Claude Code", "parent": "t1", "names": [name], "sessions": [], "addresses": addrs}
    wrapper = fixtures.WRAPPER
    return [
        {"name": "codex through a wrapper, on another machine", "runs": [short("vm/t30")], "thread": thread("review-codex", CODEX, ["vm/t30"])},
        {"name": "a codex follow-up that names its session", "runs": [whole("vm/t31")], "thread": thread("review-codex", CODEX, ["vm/t31"])},
        {"name": "a codex conversation of two runs", "runs": [short("vm/t30"), short("vm/t31")], "thread": thread("review-codex", CODEX, ["vm/t30", "vm/t31"])},
        {"name": "a codex run with an id on its command line that isn't a session", "runs": [whole("vm/t32")], "thread": thread("review-codex", CODEX, ["vm/t32"])},
        {"name": "kimi through a wrapper", "runs": [short("t40", KIMI)], "thread": thread("review-kimi", KIMI, ["t40"])},
        {"name": "a kimi follow-up that names its session", "runs": [whole("t41", KIMI)], "thread": thread("review-kimi", KIMI, ["t41"])},
        {"name": "a codex run whose log isn't there", "runs": [whole("vm/t50")], "thread": thread("review-lost", CODEX, ["vm/t50"])},
        {"name": "a program with request and answer labels", "runs": [whole("t60")], "thread": thread("lint", None, ["t60"])},
        {"name": "a machine out of reach", "runs": [whole("vm/t70")], "thread": thread("review-far", CODEX, ["vm/t70"])},
        {"name": "a codex from before 0.167", "runs": [whole("t80")], "thread": thread("review-old", CODEX, ["t80"])},
        {"name": "a kimi conversation with a round still running", "runs": [whole("t40", KIMI), whole("t41", KIMI)], "live": [short("t90", KIMI)],
         "thread": thread("review-kimi", KIMI, ["t40", "t41", "t90"])},
        {"name": "agentOf", "call": "agentOf", "args": [{"argv": [wrapper, "codex", "/w", "/b.md", "/r.md"]}]},
        {"name": "agentOf: a script", "call": "agentOf", "args": [{"argv": ["sh", "-c", "cd w && ~/.kimi-code/bin/kimi -p hi"]}]},
        {"name": "agentOf: what Herdr saw running", "call": "agentOf", "args": [{"argv": ["/bin/bash"], "program": CODEX}]},
        {"name": "agentOf: not an agent", "call": "agentOf", "args": [{"argv": ["grep", "codex", "notes.md"]}]},
        {"name": "requestFromArgv: codex", "call": "requestFromArgv", "args": [["codex", "exec", "-c", "model=o3", "Review the patch in /tmp/r1.diff please"]]},
        {"name": "requestFromArgv: kimi", "call": "requestFromArgv", "args": [["kimi", "-p", "Check it"]]},
        {"name": "requestFromArgv: a script", "call": "requestFromArgv", "args": [["sh", "-c", "codex exec 'a long prompt that is here'"]]},
        {"name": "groupThreads", "call": "groupThreads", "args": [[
            {"address": "a1", "parent": "t1", "name": "rev", "created_ms": 1},
            {"address": "a2", "parent": "t1", "name": "rev-2", "labels": {"herdr.session": "s"}, "created_ms": 3},
            {"address": "a3", "parent": "t1", "name": "rev", "labels": {"herdr.session": "s"}, "created_ms": 2},
            {"address": "a4", "parent": "t1", "created_ms": 4},
            {"address": "a6", "parent": "t2", "name": "rev", "created_ms": 6}]]},
    ]


def expect(fx, reports, answers):
    t0, told = fx["t0"] * 1000, fx["told"] * 1000
    by = {r["name"]: r for r in reports}
    rounds = lambda name: by[name].get("rounds") or []
    asked = lambda name: by[name].get("asked") or []
    for r in reports:
        if "error" in r:
            check(False, "\"%s\" ran" % r["name"], r["error"])

    name = "codex through a wrapper, on another machine"
    (r,) = rounds(name) or [{}]
    check(asked(name)[:2] == ["hc get vm/t30", "hc read vm/t30"] and [a.split(" ")[:2] for a in asked(name)[2:]] == [["sh", "vm"], ["sh", "vm"]],
          "its record and screen come from the core, its session and log from scripts run on its machine", asked(name))
    check(r.get("session") == fixtures.SID and r.get("request") == fixtures.REQUEST and r.get("answer") == fixtures.ANSWER and r.get("note") is None,
          "codex: the session in its folder (reached through a link), not the one begun at the same moment elsewhere; the request without what codex adds; the final answer",
          {k: r.get(k) for k in ("session", "request", "answer", "note")})
    want = [
        {"at": t0 + 5000, "kind": "say", "text": "Reading the patch first."},
        {"at": t0 + 6000, "kind": "read", "text": "r1.diff", "ms": 5},
        {"at": t0 + 20000, "kind": "run", "text": "cargo test -q 2>&1 | tail -5", "error": "exit 101", "ms": 12500},
        {"at": t0 + 40000, "kind": "edit", "text": "src/terms.rs, /elsewhere/new.rs (new)"},
        {"at": t0 + 50000, "kind": "search", "text": "spurious wakeup"},
        {"at": t0 + 60000, "kind": "tool", "text": "GitHub: fetch https://github.com/a/b"},
    ]
    got = [slim(s) for s in r.get("work", [])]
    check(got == want, "codex: what it said, the file it read, the command that failed with its exit code and time, its edits, a web search, an MCP call, in order", got)
    check(r.get("work", [{}, {}])[1].get("detail") == "cat r1.diff", "a step keeps its whole command for its tooltip")
    check((r.get("steps"), r.get("tokens"), r.get("cached")) == (5, 6700, 39000), "codex: 5 steps; 6,700 tokens read anew and written, 39,000 re-read from cache",
          [r.get("steps"), r.get("tokens"), r.get("cached")])
    check((r.get("at"), r.get("end"), r.get("transcript"), r.get("cut")) == (t0 + 2000, t0 + 82000, "output of vm/t30\nline 2", False),
          "the round runs from the request to the run's end, with its terminal text", [r.get("at"), r.get("end"), r.get("transcript")])
    log = [v for k, v in answers.items() if fixtures.SID in k and '"sh"' in k and "value" in v]
    size = os.path.getsize([os.path.join(d, f) for d, _, fs in os.walk(fx["codex"]) for f in fs if fixtures.SID in f][0])
    check(log and all(len(v["value"]["stdout"]) < 12000 for v in log), "codex: %d of the log's %d bytes cross over: no tool output, instructions or encrypted reasoning"
          % (max(len(v["value"]["stdout"]) for v in log) if log else -1, size))

    name = "a codex follow-up that names its session"
    (r,) = rounds(name) or [{}]
    check(len([a for a in asked(name) if a.startswith("sh")]) == 1, "a session named on the command line is read at once, without a search", asked(name))
    check((r.get("request"), r.get("answer"), [slim(s) for s in r.get("work", [])], r.get("steps"), r.get("tokens")) ==
          ("Thanks. Now check the tests too.", "Tests look fine.", [{"at": t0 + 320000, "kind": "search", "text": "parse in tests", "ms": 5}], 1, 590),
          "only the session's turn from while this run was alive", r)
    rs = rounds("a codex conversation of two runs")
    check([x.get("address") for x in rs] == ["vm/t30", "vm/t31"] and [x.get("answer") for x in rs] == [fixtures.ANSWER, "Tests look fine."],
          "two runs of one session: two rounds, each with its own answer", [x.get("address") for x in rs])

    name = "a codex run with an id on its command line that isn't a session"
    (r,) = rounds(name) or [{}]
    check((r.get("session"), r.get("request"), r.get("note")) == (fixtures.SID, fixtures.REQUEST, None) and len([a for a in asked(name) if a.startswith("sh")]) == 3,
          "an id that names no session of this run: the session is looked for after all", [r.get("session"), r.get("note"), asked(name)])

    name = "kimi through a wrapper"
    (r,) = rounds(name) or [{}]
    check([a.split(" ")[:2] for a in asked(name)[2:]] == [["sh", "here"], ["sh", "here"]], "a run on this computer is looked up here", asked(name))
    check(r.get("session") == fixtures.KID and r.get("request") == fixtures.KREQUEST and r.get("answer") == fixtures.KANSWER and r.get("note") is None,
          "kimi: the session in its folder; the request; the last step's text as the answer", {k: r.get(k) for k in ("session", "request", "answer", "note")})
    want = [
        {"at": t0 + 4000, "kind": "think", "text": "The user wants a review of staging. Let me read the plan first."},
        {"at": t0 + 4000, "kind": "say", "text": "I'll read the plan first."},
        {"at": t0 + 5000, "kind": "read", "text": "docs/plan.md", "ms": 22},
        {"at": t0 + 10000, "kind": "run", "text": "pytest -q tests/test_detect.py", "error": True, "ms": 60000},
        {"at": t0 + 71000, "kind": "edit", "text": "src/a.py", "ms": 3},
        {"at": t0 + 72000, "kind": "plan", "text": "Updated its to-do list (3 items)", "ms": 1},
        {"at": t0 + 73000, "kind": "tool", "text": "Agent", "ms": 900},
    ]
    got = [slim(s) for s in r.get("work", [])]
    check(got == want, "kimi: its thinking, what it said, the file read, the command that failed, the edit (its path within the folder), its to-do list, a tool Herdr doesn't know", got)
    check((r.get("steps"), r.get("tokens"), r.get("cached"), r.get("end")) == (5, 12000, 20000, t0 + 84000), "kimi: 5 steps; 12,000 tokens, 20,000 from cache",
          [r.get("steps"), r.get("tokens"), r.get("cached")])
    log = [v for k, v in answers.items() if fixtures.KID in k and '"sh"' in k and "value" in v]
    check(log and all(len(v["value"]["stdout"]) < 6000 for v in log), "kimi: %d of the log's %d bytes cross over: no tool output, no file contents"
          % (max(len(v["value"]["stdout"]) for v in log) if log else -1, os.path.getsize(os.path.join(fx["kimi"], "sessions/wd_kimi-ws_8653ff5eb128", fixtures.KID, "agents/main/wire.jsonl"))))
    (r,) = rounds("a kimi follow-up that names its session") or [{}]
    check((r.get("request"), r.get("answer"), r.get("steps"), r.get("tokens")) == ("And level 3?", "Level 3 is fine.", 0, 70) and
          len([a for a in asked("a kimi follow-up that names its session") if a.startswith("sh")]) == 1, "kimi -S <session>: read at once, only that turn", r)

    (r,) = rounds("a codex run whose log isn't there") or [{}]
    check(r.get("note") == "Codex's own log of this run wasn't found on vm: 2 Codex sessions were active then, none in this run's folder."
          and r.get("request") is None and r.get("answer") is None and r.get("transcript") == "output of vm/t50\nline 2",
          "no session in the run's folder: its terminal text, and a line saying where it looked and what it found", r.get("note"))
    name = "a program with request and answer labels"
    (r,) = rounds(name) or [{}]
    check((r.get("request"), r.get("answer"), r.get("note")) == ("Please review.\nCarefully.", "**LGTM**", None) and not [a for a in asked(name) if a.startswith("sh")],
          "label files give the request and the answer of any program; nothing is searched", [r.get("request"), r.get("answer"), asked(name)])
    (r,) = rounds("a machine out of reach") or [{}]
    check(r.get("note") == "Codex's own log of this run couldn't be read on vm: machine vm is unreachable" and r.get("transcript") is not None,
          "a machine that doesn't answer: the round still shows, saying so", r.get("note"))
    (r,) = rounds("a codex from before 0.167") or [{}]
    want = [
        {"at": told + 3000, "kind": "think", "text": "Inspecting the allocator"},
        {"at": told + 5000, "kind": "run", "text": 'rg -n "reserved(" src/'},
        {"at": told + 20000, "kind": "say", "text": "Looking closer at the matcher."},
        {"at": told + 30000, "kind": "edit", "text": "src/terms.rs"},
        {"at": told + 31000, "kind": "search", "text": "spurious wakeup"},
    ]
    got = [slim(s) for s in r.get("work", [])]
    check(got == want and (r.get("request"), r.get("answer"), r.get("steps"), r.get("tokens"), r.get("cut")) == ("Review the old way please, thoroughly", "All good.", 3, 3400, True),
          "an older codex log (no record of what calls did): steps from the calls themselves", got)
    rs = rounds("a kimi conversation with a round still running")
    check(len(rs) == 3 and [x.get("live") for x in rs] == [False, False, True] and rs[-1].get("request") == "One more: check the docs as well.",
          "a follow-up still running is the last round, with its request", [x.get("live") for x in rs])

    result = lambda name: by[name].get("result")
    check([result(n) for n in ("agentOf", "agentOf: a script", "agentOf: what Herdr saw running", "agentOf: not an agent")] == ["codex", "kimi", "codex", None],
          "whose log to look for: a wrapper's first argument, a script's words, what Herdr saw running; not any argument")
    check([result(n) for n in ("requestFromArgv: codex", "requestFromArgv: kimi", "requestFromArgv: a script")] == ["Review the patch in /tmp/r1.diff please", "Check it", None],
          "the request from a command line; none from a script")
    check([[k["address"] for k in th["runs"]] for th in result("groupThreads") or []] == [["a1", "a3", "a2"], ["a4"], ["a6"]],
          "runs group by parent and name, joined by a shared session; unnamed ones stand alone")


def real_cases(addresses, machine, together):
    rows = {t["address"]: t for t in json.loads(subprocess.run(["hc", "ls", "--all", "--json"], capture_output=True, text=True).stdout)["terminals"]}
    at = lambda a: "%s/%s" % (machine, a) if machine else a
    runs = []
    for a in addresses:
        if a not in rows:
            sys.exit("herdr-core has no terminal %s" % a)
        t = rows[a]
        runs.append({"address": at(a), "name": t.get("name"), "parent": at(t["parent"]) if t.get("parent") else None, "state": t["state"], "program": None})
    groups = [runs] if together else [[r] for r in runs]
    return [{"name": " + ".join(local(r["address"]) for r in g), "brief": True, ("live" if g[0]["state"] == "live" else "runs"): g,
             "thread": {"name": g[0]["name"] or g[0]["address"], "program": None, "asker": "Parent", "parent": g[0]["parent"], "names": [], "sessions": [], "addresses": [r["address"] for r in g]}}
            for g in groups]


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--real", nargs="+", metavar="ADDRESS")
    p.add_argument("--as", dest="machine", metavar="MACHINE")
    p.add_argument("--together", action="store_true")
    a = p.parse_args()
    if not shutil.which("herdr-app"):
        sys.exit("herdr-app isn't on PATH")
    with tempfile.TemporaryDirectory(prefix="agents-mod-check-") as tmp:
        folder = os.path.join(tmp, "agents-check")
        if a.real:
            cases = real_cases(a.real, a.machine, a.together)
            world = {"hc_exec": bool(a.machine)}
            reports, answers = settle(folder, cases, world)
            print(json.dumps(reports, indent=1))
            print("what the mod asked for, how long it took and how much came back:\n  " + "\n  ".join(world.get("took", [])))
            views(folder, cases, answers, reports, range(len(cases)))
        else:
            fx = fixtures.make(os.path.join(tmp, "fixtures"))
            cases = fixture_cases(fx)
            # Runs addressed vm/... go through `hc exec` when a core is there to ask, as in the app.
            core = subprocess.run(["hc", "exec", "--json", "--", "true"], capture_output=True).returncode == 0 if shutil.which("hc") else False
            world = {"records": fx["records"], "screens": fx["screens"], "env": {"CODEX_HOME": fx["codex"], "KIMI_CODE_HOME": fx["kimi"]},
                     "hc_exec": core, "unreachable": fx["ws"]}
            reports, answers = settle(folder, cases, world)
            expect(fx, reports, answers)
            print("     (scripts for vm/... ran %s)" % ("through hc exec" if core else "directly: no herdr-core to go through"))
            views(folder, cases, answers, reports, [i for i, c in enumerate(cases) if "thread" in c])
    print("%d failed" % failed if failed else "all passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
