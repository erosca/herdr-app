"""Session logs in the formats codex 0.169 and Kimi Code 2.5 really write (taken from
logs on a machine that runs both), with made-up content, and the runs that left them.

make(root) writes them under root and returns what check.py needs: the homes to point
CODEX_HOME and KIMI_CODE_HOME at, each run's record as `hc get` gives it, and each
run's terminal text as `hc read` gives it. Times are relative to now, and each file's
modified time is its session's end, as on a real machine.

Antigravity (agy) leaves no log Herdr reads, but the events it printed: relay's recording
of a real run (agy-events.jsonl), and turns made up in the same format (agy_runs).

Three runs are still going. The codex one's log is written in three goes (`live_file`,
then `stages`: what check.py appends before the second and the third look), the first
of them ending in the middle of a line, as a log does while it is written; the agy one's
events too (`agy_live`, `agy_stages`)."""

import json
import os
import time

SID = "01a1d7eb-92d6-7c71-bd79-b00a0302c0ea"   # the codex session
DECOY = "01a1d7eb-0000-7c71-bd79-b00a0302c0ea"
OLD = "0199a213-81c0-7800-8aa1-bbab2c41ebaf"    # a codex session in the format before 0.167
KID = "session_dab28818-7fd5-4a02-9d9e-14f554205bab"
KDECOY = "session_aaaaaaaa-0000-4000-8000-000000000000"
LIVE = "01a1d7eb-1111-7c71-bd79-b00a0302c0ea"    # a codex session still being written
KLIVE = "session_bbbbbbbb-1111-4000-8000-000000000000"
LREQUEST = "Check the parser.\nBe thorough."
WRAPPER = "/home/u/.claude/skills/external-review/run-reviewer.sh"
REQUEST = "Review the patch in r1.diff for bugs.\n\n<notes>\nKeep it short.\n</notes>"
ANSWER = "## Findings\n- an off-by-one in `parse`"
KREQUEST = "Review the staged changes for false positives.\nFocus on level 2."
KANSWER = "**Verdict:** two real problems.\n\n1. T9 fires on aliases."
BIG = 'line "with" quotes, "exit_code":7, "isError":true, "output":"x" and a \\ backslash\n' * 4000


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % (int(t * 1000) % 1000)


def compact(o):
    return json.dumps(o, separators=(",", ":"))


def write(path, lines, mtime):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.utime(path, (mtime, mtime))


def codex_session(t0, sid, cwd, turns):
    """One rollout: {timestamp, ordinal, type, payload} a line, as codex 0.169 writes."""
    lines = []

    def add(dt, kind, payload):
        lines.append(compact({"timestamp": iso(t0 + dt), "ordinal": len(lines), "type": kind, "payload": payload}))

    def item(dt, it, ms=0):
        at = int((t0 + dt) * 1000)
        add(dt, "event_msg", {"type": "item_completed", "thread_id": sid, "turn_id": "turn", "item": it, "started_at_ms": at, "completed_at_ms": at + ms})

    def user(dt, text, kinds):
        add(dt, "response_item", {"type": "message", "id": "msg_1", "role": "user", "content": [{"type": "input_text", "text": text}],
                                  "internal_chat_message_metadata_passthrough": {"turn_id": "turn", "content_item_kinds": kinds}})

    def said(dt, text, phase):
        add(dt, "response_item", {"type": "message", "id": "msg_2", "role": "assistant", "content": [{"type": "output_text", "text": text}], "phase": phase})
        item(dt, {"type": "AgentMessage", "id": "msg_2", "content": [{"type": "Text", "text": text}], "phase": phase})

    def tokens(dt, new, cached, out):
        usage = {"input_tokens": new + cached, "cached_input_tokens": cached, "cache_write_input_tokens": 0, "output_tokens": out,
                 "reasoning_output_tokens": 0, "total_tokens": new + cached + out}
        add(dt, "event_msg", {"type": "token_count", "info": {"total_token_usage": usage, "last_token_usage": usage, "model_context_window": 258400}, "rate_limits": {}})

    def command(dt, script, parsed, code=0, secs=0.005):
        add(dt, "response_item", {"type": "custom_tool_call", "id": "ctc_1", "status": "completed", "call_id": "call_1", "name": "exec", "input": "await run(...)"})
        add(dt, "response_item", {"type": "custom_tool_call_output", "call_id": "call_1", "output": BIG})
        item(dt, {"type": "CommandExecution", "id": "exec-1", "process_id": "1", "command": ["/bin/bash", "-lc", script], "cwd": cwd,
                  "parsed_cmd": parsed, "source": "unified_exec_startup", "status": "completed" if code == 0 else "failed",
                  "aggregated_output": BIG, "exit_code": code, "duration": {"secs": int(secs), "nanos": int((secs % 1) * 1e9)}}, int(secs * 1000))

    add(1, "session_meta", {"account_scoped": True, "session_id": sid, "id": sid, "timestamp": iso(t0 + 1), "cwd": cwd, "runtime_workspace_roots": [cwd],
                            "originator": "codex_exec", "cli_version": "0.169.0", "base_instructions": {"text": "x" * 20000}, "history_mode": "paginated"})
    add(1, "response_item", {"type": "message", "id": "msg_0", "role": "developer", "content": [{"type": "input_text", "text": "z" * 30000}]})
    for n, turn in enumerate(turns):
        turn(add, item, user, said, tokens, command, n)
    return lines


def context(add, dt, cwd, effort):
    """The turn's settings, as codex writes them ahead of its request (some 3 kB)."""
    add(dt, "turn_context", {"turn_id": "turn", "cwd": cwd, "approval_policy": "never", "permission_profile": {"x": "p" * 1200}, "model": "gpt-test",
                             "collaboration_mode": {"mode": "default", "settings": {"model": "gpt-test", "reasoning_effort": effort}}, "effort": effort,
                             "summary": "none", "file_system_sandbox_policy": {"x": "s" * 1100}})


def first_turn(cwd):
    def turn(add, item, user, said, tokens, command, _n):
        add(1, "event_msg", {"type": "task_started", "turn_id": "turn", "started_at": 0})
        context(add, 1, cwd, "low")
        user(2, "<environment_context>\n  <cwd>%s</cwd>\n</environment_context>" % cwd, ["environments.environment_context"])
        user(2, REQUEST, ["user.text"])
        item(2, {"type": "UserMessage", "id": "u1", "content": [{"type": "text", "text": REQUEST, "text_elements": []}]})
        add(4, "response_item", {"type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "QUFB" * 20000})
        item(4, {"type": "Reasoning", "id": "rs_1", "summary_text": [], "raw_content": []})
        said(5, "Reading the patch first.", "commentary")
        command(6, "cat r1.diff", [{"type": "read", "cmd": "cat r1.diff", "name": "r1.diff", "path": "r1.diff"}])
        tokens(7, 3000, 9000, 300)
        command(20, "cargo test -q 2>&1 | tail -5", [{"type": "unknown", "cmd": "cargo test -q 2>&1 | tail -5"}], code=101, secs=12.5)
        item(40, {"type": "FileChange", "id": "exec-2", "changes": {cwd + "/src/terms.rs": {"type": "update", "unified_diff": BIG, "move_path": None},
                                                                "/elsewhere/new.rs": {"type": "add", "content": BIG}}, "status": "completed", "stdout": BIG, "stderr": ""}, 40)
        item(50, {"type": "Extension", "kind": "web.search", "id": "exec-3", "query": "spurious wakeup", "action": {"type": "search", "query": "spurious wakeup", "queries": None},
                  "results": [{"type": "text_result", "domain": "example.com", "snippet": BIG, "title": "t", "url": "https://example.com"}]})
        item(60, {"type": "McpToolCall", "id": "exec-4", "server": "codex_apps", "tool": "github.fetch", "arguments": {"url": "https://github.com/a/b"},
                  "appName": "GitHub", "actionName": "fetch", "status": "completed", "result": {"content": [{"type": "text", "text": BIG}]}})
        tokens(78, 2200, 30000, 1200)
        said(79, ANSWER, "final_answer")
        add(80, "event_msg", {"type": "task_complete", "turn_id": "turn", "last_agent_message": ANSWER})
    return turn


def second_turn(add, item, user, said, tokens, command, _n):
    add(300, "event_msg", {"type": "task_started", "turn_id": "turn2", "started_at": 0})
    context(add, 300, "/w", "high")
    user(301, "Thanks. Now check the tests too.", ["user.text"])
    command(320, "rg -n parse tests", [{"type": "search", "cmd": "rg -n parse tests", "query": "parse", "path": "tests"}])
    tokens(358, 500, 41000, 90)
    said(359, "Tests look fine.", "final_answer")
    add(360, "event_msg", {"type": "task_complete", "turn_id": "turn2", "last_agent_message": "Tests look fine."})


def live_turn(cwd):
    """A turn as it is written while it goes on; check.py's three looks see it grow."""
    def turn(add, item, user, said, tokens, command, _n):
        add(1, "event_msg", {"type": "task_started", "turn_id": "turn", "started_at": 0})
        user(2, "Check the parser, as it was sent.", ["user.text"])
        said(3, "Starting with the **parser**.", "commentary")
        command(4, "cat src/parse.rs", [{"type": "read", "cmd": "cat src/parse.rs", "name": "parse.rs", "path": "src/parse.rs"}])
        tokens(5, 1000, 2000, 100)
        # The first look ends here (10 lines); the second gets the next command and half of the edit's line.
        command(20, "cargo check", [{"type": "unknown", "cmd": "cargo check"}], secs=3)
        item(30, {"type": "FileChange", "id": "exec-2", "changes": {cwd + "/src/parse.rs": {"type": "update", "unified_diff": BIG, "move_path": None}}, "status": "completed", "stdout": "", "stderr": ""}, 40)
        tokens(40, 500, 4000, 60)
        said(45, "Parser is fine.", "final_answer")
        add(46, "event_msg", {"type": "task_complete", "turn_id": "turn", "last_agent_message": "Parser is fine."})
    return turn


def kimi_live_session(t0, cwd):
    """A wire.jsonl whose turn isn't over: sixteen steps so far, its last text half an answer."""
    lines = [compact({"type": "metadata", "protocol_version": "1.5", "created_at": int(t0 * 1000)})]

    def add(dt, kind, **rest):
        lines.append(compact({"type": kind, **rest, "time": int((t0 + dt) * 1000)}))

    def loop(dt, **event):
        add(dt, "context.append_loop_event", agentId="main", event=event)

    add(1, "turn.prompt", agentId="main", input=[{"type": "text", "text": "Look at the docs."}], origin={"kind": "user"}, promptId="msg_1", turnId=0)
    loop(2, type="step.begin", uuid="s1", turnId="0", step=1)
    loop(3, type="content.part", uuid="p1", turnId="0", step=1, part={"type": "think", "think": "Docs first."})
    loop(3, type="content.part", uuid="p2", turnId="0", step=1, part={"type": "text", "text": "Looking at the docs, *all* of them."})
    for n in range(14):
        loop(4 + n, type="tool.call", uuid="u%d" % n, turnId="0", step=1, stepUuid="s", toolCallId="tool_%d" % n, name="Read",
             args={"path": "docs/%d.md" % n}, display={"kind": "file_io", "operation": "read", "path": "%s/docs/%d.md" % (cwd, n)})
        loop(4 + n, type="tool.result", parentUuid="u%d" % n, toolCallId="tool_%d" % n, result={"output": BIG, "durationMs": 7})
    loop(20, type="step.end", uuid="s1", turnId="0", step=1, finishReason="tool_use", usage={"inputOther": 800, "output": 200, "inputCacheRead": 5000, "inputCacheCreation": 0})
    loop(21, type="step.begin", uuid="s2", turnId="0", step=2)
    loop(22, type="content.part", uuid="p3", turnId="0", step=2, part={"type": "text", "text": "Half an ans"})
    return lines


def old_codex_session(t0, sid, cwd):
    """Before 0.167: no ordinal, no item_completed; the calls themselves are all there is."""
    def line(dt, kind, payload):
        return compact({"timestamp": iso(t0 + dt), "type": kind, "payload": payload})
    total = {"input_tokens": 9000, "cached_input_tokens": 6000, "output_tokens": 400, "total_tokens": 9400}
    return [
        line(1, "session_meta", {"id": sid, "timestamp": iso(t0 + 1), "cwd": cwd, "originator": "codex_exec", "instructions": "x" * 5000}),
        line(2, "response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n<cwd>/w</cwd>\n</environment_context>"},
                                                                               {"type": "input_text", "text": "Review the old way please, thoroughly"}]}),
        line(3, "response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": "**Inspecting the allocator**\n\nI'll look at reserved keys."}], "encrypted_content": "QUFB"}),
        line(5, "response_item", {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": 'rg -n "reserved(" src/'}), "call_id": "c1"}),
        line(6, "response_item", {"type": "function_call_output", "call_id": "c1", "output": BIG}),
        line(20, "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Looking closer at the matcher."}], "phase": "commentary"}),
        line(30, "response_item", {"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: src/terms.rs\n@@\n-a\n+b\n*** End Patch", "call_id": "c2"}),
        line(31, "response_item", {"type": "web_search_call", "action": {"type": "search", "query": "spurious wakeup"}}),
        line(40, "event_msg", {"type": "token_count", "info": {"total_token_usage": total, "last_token_usage": total}}),
        line(41, "response_item", {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "All good."}], "phase": "final_answer"}),
    ]


def kimi_session(t0, cwd):
    """wire.jsonl, protocol 1.5: {type, ..., time: ms} a line."""
    lines = [compact({"type": "metadata", "protocol_version": "1.5", "created_at": int(t0 * 1000)})]

    def add(dt, type_, **rest):
        lines.append(compact({"type": type_, **rest, "time": int((t0 + dt) * 1000)}))

    def loop(dt, **event):
        add(dt, "context.append_loop_event", agentId="main", event=event)

    def call(dt, step, n, name, args, display):
        loop(dt, type="tool.call", uuid="u%d" % n, turnId="0", step=step, stepUuid="s", toolCallId="tool_%d" % n, name=name, args=args, display=display)

    def result(dt, n, **res):
        loop(dt, type="tool.result", parentUuid="u%d" % n, toolCallId="tool_%d" % n, result=res)

    def usage(new, out, cached):
        return {"inputOther": new, "output": out, "inputCacheRead": cached, "inputCacheCreation": 0}

    add(0, "profile.bind", agentId="main", modelAlias="kimi-code/k3.1-pro", systemPrompt="y" * 12000)
    lines.append(compact({"message": {"message": {"role": "user", "content": [{"type": "text", "text": BIG}]}}, "type": "agent.message.appended", "time": int(t0 * 1000), "kind": "event"}))
    add(2, "turn.prompt", agentId="main", input=[{"type": "text", "text": KREQUEST}], origin={"kind": "user"}, promptId="msg_1", turnId=0)
    add(2, "context.append_message", agentId="main", message={"role": "user", "content": [{"type": "text", "text": KREQUEST}]})
    ask = lambda dt, effort: add(dt, "llm.request", agentId="main", kind="loop", provider="openai", model="k-test", modelAlias="kimi-code/k-test",
                                 thinkingEffort=effort, thinkingKeep="all", toolSelect=False, systemPromptHash="h" * 64, toolsHash="h" * 64, messageCount=3, turnStep="0.1")
    ask(3, "max")
    ask(8, "low")
    loop(3, type="step.begin", uuid="s1", turnId="0", step=1)
    loop(4, type="content.part", uuid="p1", turnId="0", step=1, part={"type": "think", "think": "The user wants a review of staging. Let me read the plan first.\nThen the code.", "reasoningKey": "reasoning_content"})
    loop(4, type="content.part", uuid="p2", turnId="0", step=1, part={"type": "text", "text": "I'll read the plan first."})
    call(5, 1, 1, "Read", {"path": "docs/plan.md", "max_chars": 100000}, {"kind": "file_io", "operation": "read", "path": cwd + "/docs/plan.md"})
    result(6, 1, output=BIG, durationMs=22)
    loop(7, type="step.end", uuid="s1", turnId="0", step=1, finishReason="tool_use", usage=usage(9000, 300, 0))
    lines.append(compact({"type": "usage.record", "agentId": "main", "usage": usage(9000, 300, 0), "usageScope": "turn", "time": int((t0 + 7) * 1000)}))
    loop(8, type="step.begin", uuid="s2", turnId="0", step=2)
    call(10, 2, 2, "Bash", {"command": "pytest -q tests/test_detect.py", "cwd": cwd, "timeout": 120}, {"kind": "command", "command": "pytest -q tests/test_detect.py"})
    result(70, 2, output="1 failed", isError=True, durationMs=60000)
    call(71, 2, 3, "Edit", {"path": cwd + "/src/a.py", "old_string": BIG, "new_string": BIG}, {"kind": "file_io", "operation": "edit", "path": cwd + "/src/a.py"})
    result(71, 3, output="Edited", durationMs=3, note="x")
    call(72, 2, 4, "TodoList", {"todos": [{"title": "a", "status": "done"}, {"title": "b", "status": "in_progress"}, {"title": "c", "status": "pending"}]}, {"kind": "todo_list", "items": []})
    result(72, 4, output="ok", durationMs=1)
    call(73, 2, 5, "Agent", {"prompt": "look around"}, {"kind": "agent"})
    result(73, 5, output="done", durationMs=900)
    loop(74, type="step.end", uuid="s2", turnId="0", step=2, finishReason="tool_use", usage=usage(1200, 800, 9000))
    loop(75, type="step.begin", uuid="s3", turnId="0", step=3)
    loop(80, type="content.part", uuid="p3", turnId="0", step=3, part={"type": "text", "text": "**Verdict:** two real problems.\n\n1. T9 "})
    loop(81, type="content.part", uuid="p4", turnId="0", step=3, part={"type": "text", "text": "fires on aliases."})
    loop(82, type="step.end", uuid="s3", turnId="0", step=3, finishReason="end_turn", usage=usage(100, 600, 11000))
    add(82, "turn.ended", agentId="main", turnId=0, reason="completed", durationMs=80000)
    add(82, "prompt.completed", agentId="main", promptId="msg_1", reason="completed")
    # A follow-up, with `kimi -S <session>`.
    add(300, "turn.prompt", agentId="main", input=[{"type": "text", "text": "And level 3?"}], origin={"kind": "user"}, promptId="msg_2", turnId=1)
    ask(300, "high")
    loop(301, type="step.begin", uuid="s4", turnId="1", step=1)
    loop(320, type="content.part", uuid="p5", turnId="1", step=1, part={"type": "text", "text": "Level 3 is fine."})
    loop(321, type="step.end", uuid="s4", turnId="1", step=1, finishReason="end_turn", usage=usage(50, 20, 12000))
    add(322, "turn.ended", agentId="main", turnId=1, reason="completed", durationMs=22000)
    return lines


AGY = "42a4665b-0d41-41d9-8c54-e2153b4e89e7"   # the Antigravity conversation of agy-events.jsonl
AREQUEST = "Make notes.txt and show it."
AANSWER = "**Done:** notes.txt holds the line."
ABRIEF2 = "Now break something, then answer."
ALREQUEST = "Look around, then say what you saw."
RECORDED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agy-events.jsonl")


def agy_recorded(cwd, spaced=True, big=None, noise=False):
    """relay's recording of a real agy run (agy 1.5.14, `--output-format stream-json`), in `cwd`.
    `spaced`: as recorded (Python's spacing), else as agy prints (compact); `big`: what the
    last command printed, in place of its output; `noise`: lines agy's stderr adds."""
    lines = []
    with open(RECORDED) as f:
        for line in f:
            e = json.loads(line.replace("/tmp/agy-ws", cwd))
            info = e.get("step_update", {}).get("tool_info", {})
            if big and info.get("parameters", {}).get("CommandLine") == "cat notes.txt" and "output" in info:
                info["output"] = "Created At: 2026-11-21T19:39:26+01:00\nCompleted At: 2026-11-21T19:39:26+01:00\nCommand exited with code 0.\n\nCommand output:\n" + big
            lines.append(json.dumps(e) if spaced else compact(e))
    return (["Warning: falling back to the default keyring"] + lines + ["", "agy: done"]) if noise else lines


def agy_turn(model, steps, answer, total):
    """An agy turn of the conversation AGY: `steps` are (tool, parameters, state, output, error)."""
    ev = lambda kind, body: compact({"event": kind, **({"conversation_id": AGY} if kind != "step_update" else {}), kind: body})
    up = lambda i, state, kind, **more: ev("step_update", {"conversation_id": AGY, "step_index": i, "state": state, "step_type": kind, **more})
    usage = lambda n: {"input_tokens": n, "output_tokens": 10, "thinking_tokens": 4, "cache_read_tokens": 100 * n, "total_tokens": n + 10}
    lines = [ev("init", {"model": model, "cwd": "/w", "tools": ["run_command", "read_file"], "permission_mode": "request-review"}), up(0, "DONE", "user_input")]
    i = 1
    for tool, params, state, output, error in steps:
        lines.append(up(i, "DONE", "agent_response", duration_seconds=1.0, usage=usage(100 * i)))
        info = {"name": tool, "parameters": params}
        lines.append(up(i + 1, "ACTIVE", "tool", tool_name=tool, tool_info=info))
        done = {**info, **({"output": output} if output is not None else {}), **({"error": {"type": "TOOL_ERROR", "message": error}} if error else {})}
        lines.append(up(i + 1, state, "tool", tool_name=tool, duration_seconds=2.5, tool_info=done))
        i += 2
    for n, piece in enumerate([answer[: len(answer) // 2], answer[len(answer) // 2:]]):
        lines.append(up(i, "DONE" if n else "ACTIVE", "agent_response", text_delta=piece, **({"duration_seconds": 3.0, "usage": usage(7)} if n else {})))
    lines.append(ev("result", {"status": "SUCCESS", "response": "Commentary. " + answer, "duration_seconds": 9.0, "num_turns": 2,
                               "usage": {"input_tokens": total, "output_tokens": 50, "thinking_tokens": 0, "cache_read_tokens": total, "total_tokens": total + 50}}))
    return lines


def agy_runs(root, ws, t0, now, record):
    """Antigravity's runs: through relay (labels, events.jsonl in the round's folder), through
    run-reviewer.sh alone (REPORT.events: a first round and its follow-up), events files that
    are another run's, and one still going, written in three goes (as the codex one)."""
    aws, alws = os.path.join(ws, "agy-ws"), os.path.join(ws, "agy-live")
    for d in (aws, alws):
        os.makedirs(d)
    rd = os.path.join(root, "relay/runs/agy-notes-a1b2c3/round-1")
    write(rd + "/brief.md", [AREQUEST], t0 + 400)
    write(rd + "/report.md", [AANSWER], t0 + 412)
    write(rd + "/events.jsonl", agy_recorded(aws, spaced=False, big='"quoted" \\ and "output": "x", more\n' * 20000, noise=True), t0 + 410)
    brief, report, brief2, report2 = ws + "/agy-brief.md", ws + "/agy-report.md", ws + "/agy-brief-2.md", ws + "/agy-report-2.md"
    write(brief, [AREQUEST], t0 + 500)
    write(report + ".events", agy_recorded(aws), t0 + 510)
    write(brief2, [ABRIEF2], t0 + 600)
    write(report2 + ".events", agy_turn("gemini-4-neon-xhigh", [
        ("run_command", {"CommandLine": "false"}, "DONE", "Created At: x\nCompleted At: y\nCommand exited with code 1.\n\nCommand output:\n", None),
        ("read_file", {"Path": aws + "/gone.md", "StartLine": 1, "EndLine": 40}, "ERROR", None, "file does not exist"),
        ("grep_search", {"Query": "TODO", "SearchPath": aws + "/src"}, "DONE", "src/a.rs:1: TODO", None),
        ("browser_click_element", {"Index": 3}, "DONE", "", None)], "Second answer, **after** the tools.", 99999), t0 + 620)
    write(ws + "/agy-stale.md.events", agy_recorded(aws), t0 - 3600)
    write(ws + "/agy-later.md.events", agy_recorded(aws), t0 + 1000)
    records = {
        "t100": record("t100", "agy-notes-a1b2c3", [WRAPPER, "agy", aws, rd + "/brief.md", rd + "/report.md"], aws, t0 + 400, t0 + 412,
                       labels={"herdr.request": rd + "/brief.md", "herdr.answer": rd + "/report.md", "herdr.session": AGY, "herdr.title": "Notes file"}),
        "t101": record("t101", "review-agy", [WRAPPER, "agy", "agy-ws", "../agy-brief.md", report], aws, t0 + 500, t0 + 512),
        "t102": record("t102", "review-agy", [WRAPPER, "agy", aws, brief2, report2, AGY], aws, t0 + 600, t0 + 625),
        "t104": record("t104", "review-agy-stale", [WRAPPER, "agy", aws, brief, ws + "/agy-stale.md"], aws, t0 + 700, t0 + 710),
        "t105": record("t105", "review-agy-later", [WRAPPER, "agy", aws, brief, ws + "/agy-later.md"], aws, t0 + 700, t0 + 710),
    }
    # The one still going: as relay starts it, before it labels the session.
    tl = round(now - 50)
    lrd = os.path.join(root, "relay/runs/agy-live-d4e5f6/round-1")
    write(lrd + "/brief.md", [ALREQUEST], tl)
    going = agy_recorded(alws, spaced=False)
    live = lrd + "/events.jsonl"
    write(live, going[:12], now)
    half = len(going[20]) // 2
    stages = ["\n".join(going[12:20]) + "\n" + going[20][:half], going[20][half:] + "\n" + "\n".join(going[21:]) + "\n"]
    records["t103"] = {**record("t103", "agy-live-d4e5f6", [WRAPPER, "agy", alws, lrd + "/brief.md", lrd + "/report.md"], alws, tl, now,
                                labels={"herdr.request": lrd + "/brief.md", "herdr.answer": lrd + "/report.md"}),
                       "state": "live", "finished_ms": None, "exit_code": None, "reason": None, "status": {"app": "agy", "state": "working"}}
    return records, {"aws": aws, "alws": alws, "agy_live": live, "agy_stages": stages, "agy_tl": tl, "agy_rd": rd}


def make(root):
    now = time.time()
    t0 = round(now - 1200)   # the runs began twenty minutes ago
    told = round(now - 3000)
    ws = os.path.join(root, "ws")
    cws, kws, link = os.path.join(ws, "codex-ws"), os.path.join(ws, "kimi-ws"), os.path.join(ws, "link")
    lws, klws = os.path.join(ws, "live-ws"), os.path.join(ws, "kimi-live")
    for d in (cws, kws, lws, klws, os.path.join(ws, "empty"), os.path.join(ws, "old")):
        os.makedirs(d)
    os.symlink(cws, link)   # the run's folder as herdr-core has it; codex records where it leads

    codex = os.path.join(root, "codex")
    day = time.strftime("%Y/%m/%d", time.localtime(t0))
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.localtime(t0))
    write("%s/sessions/%s/rollout-%s-%s.jsonl" % (codex, day, stamp, SID), codex_session(t0, SID, cws, [first_turn(cws), second_turn]), t0 + 360)
    write("%s/sessions/%s/rollout-%s-%s.jsonl" % (codex, day, stamp, DECOY), codex_session(t0, DECOY, "/somewhere/else", [first_turn("/somewhere/else")]), t0 + 80)
    write("%s/sessions/%s/rollout-%s-%s.jsonl" % (codex, day, stamp, OLD), old_codex_session(told, OLD, os.path.join(ws, "old")), told + 41)

    # A codex run still going, begun a minute ago: its log so far, and what is written next.
    tl = round(now - 60)
    going = codex_session(tl, LIVE, lws, [live_turn(lws)])
    live_file = "%s/sessions/%s/rollout-%s-%s.jsonl" % (codex, time.strftime("%Y/%m/%d", time.localtime(tl)), time.strftime("%Y-%m-%dT%H-%M-%S", time.localtime(tl)), LIVE)
    write(live_file, going[:10], now)
    half = len(going[13]) // 2
    stages = ["\n".join(going[10:13]) + "\n" + going[13][:half], going[13][half:] + "\n" + "\n".join(going[14:]) + "\n"]

    kimi = os.path.join(root, "kimi")
    tk = round(now - 40)
    for folder, kid, cwd, lines, end in (("wd_kimi-ws_8653ff5eb128", KID, kws, kimi_session(t0, kws), t0 + 322),
                                         ("wd_kimi-live_111111111111", KLIVE, klws, kimi_live_session(tk, klws), now),
                                         ("wd_other_000000000000", KDECOY, "/somewhere/else", kimi_session(t0, "/somewhere/else"), t0 + 322)):
        d = "%s/sessions/%s/%s" % (kimi, folder, kid)
        write(d + "/agents/main/wire.jsonl", lines, end)
        state = {"id": kid, "version": 2, "cwd": cwd, "archived": False, "agents": {"main": {"homedir": d + "/agents/main", "type": "main"}}, "custom": {},
                 "lastTurnReason": "completed", "createdAt": int(t0 * 1000), "updatedAt": int(end * 1000), "isCustomTitle": False}
        write(d + "/state.json", [json.dumps(state, indent=2)], end)

    files = os.path.join(root, "files")
    write(files + "/req.md", ["Please review.", "Carefully."], t0)
    write(files + "/ans.md", ["**LGTM**"], t0)
    write(files + "/live-req.md", LREQUEST.split("\n"), now)

    def record(address, name, argv, cwd, start, end, **more):
        return {"address": address.split("/")[-1], "name": name, "labels": {"where": "vm / 1"}, "argv": argv, "cwd": cwd, "keep": False, "state": "finished",
                "exit_code": 0, "signal": None, "reason": "exited", "created_ms": int(start * 1000), "finished_ms": int(end * 1000), "screen": "exact",
                "parent": "t1", **more}

    brief, report = ws + "/BRIEF.md", ws + "/report.md"
    records = {
        # Through a wrapper, the prompt on stdin, on another machine, in a folder reached by a link.
        "vm/t30": record("vm/t30", "review-codex", [WRAPPER, "codex", link, brief, report], link, t0, t0 + 82),
        "vm/t31": record("vm/t31", "review-codex", [WRAPPER, "codex", link, brief, report, SID], link, t0 + 299, t0 + 362),
        # An argument shaped like a session id that isn't one.
        "vm/t32": record("vm/t32", "review-codex", [WRAPPER, "codex", link, brief, report, "11111111-2222-4333-8444-555555555555"], link, t0, t0 + 82),
        "t40": record("t40", "review-kimi", [WRAPPER, "kimi", kws, brief, report], kws, t0, t0 + 84),
        "t41": record("t41", "review-kimi", [WRAPPER, "kimi", kws, brief, report, KID], kws, t0 + 299, t0 + 324),
        "vm/t50": record("vm/t50", "review-lost", ["codex", "exec", "-"], ws + "/empty", t0, t0 + 60),
        "t60": record("t60", "lint", ["some-tool", "--go"], ws, t0, t0 + 5, exit_code=1,
                      labels={"herdr.request": files + "/req.md", "herdr.answer": files + "/ans.md"}),
        "vm/t70": record("vm/t70", "review-far", ["sh", "-c", "cd w && codex exec - < brief.md"], ws, t0, t0 + 60),
        "t80": record("t80", "review-old", ["codex", "exec", "Review the old way please, thoroughly"], ws + "/old", told, told + 42),
        "t90": {**record("t90", "review-kimi", ["kimi", "-p", "One more: check the docs as well."], kws, now - 30, now), "state": "live", "finished_ms": None, "exit_code": None, "reason": None},
    }
    going = {"state": "live", "finished_ms": None, "exit_code": None, "reason": None}
    records["vm/t91"] = {**record("vm/t91", "review-live", [WRAPPER, "codex", lws, brief, report], lws, tl, now, labels={"herdr.request": files + "/live-req.md"}), **going}
    records["t92"] = {**record("t92", "review-kimi-live", [WRAPPER, "kimi", klws, brief, report], klws, tk, now), **going}
    agy, more = agy_runs(root, ws, t0, now, record)
    records.update(agy)
    screens = {a: {"text": "output of %s\nline 2\n\n\n" % a, "complete": a != "t80", "how": "history"} for a in records}
    return {"codex": codex, "kimi": kimi, "records": records, "screens": screens, "t0": t0, "told": told, "tl": tl, "tk": tk, "ws": ws, "cws": cws, "kws": kws,
            "link": link, "files": files, "live_file": live_file, "stages": stages, **more}
