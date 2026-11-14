#!/usr/bin/env python3
"""Writes fixtures/fixhome: a codex session log and kimi session logs in their real
on-disk formats (from openai/codex c2c1ebb and MoonshotAI/kimi-cli 9ab1286), for
harness.mjs. Times are relative to now: `find -newermt` must see the files as
written after the runs began, as real logs are.

    python3 make-fixtures.py            # then: node harness.mjs ../../../defaults/mods/agents .
"""
import hashlib
import json
import os
import shutil
import sys
import time

here = os.path.dirname(os.path.abspath(__file__))
home = os.path.join(here, "fixhome")
shutil.rmtree(home, ignore_errors=True)

now = time.time()
T0 = now - 600            # the kimi run: ten minutes ago
CT0 = round(now - 1200)   # the codex run: twenty minutes ago
SID = "0199a213-81c0-7800-8aa1-bbab2c41ebaf"
KID = "5f1c2e8a-6b7d-4c3e-9a10-2b3c4d5e6f70"


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".000Z"


# codex: serde_json, compact. {timestamp, type, payload} a line.
def c(o):
    return json.dumps(o, separators=(",", ":"))


cl = [
    c({"timestamp": iso(CT0 + 1), "type": "session_meta", "payload": {"id": SID, "cwd": "/w", "timestamp": iso(CT0 + 1), "instructions": "x" * 5000}}),
    c({"timestamp": iso(CT0 + 1), "type": "turn_context", "payload": {"cwd": "/w", "user_instructions": "y" * 20000}}),
    c({"timestamp": iso(CT0 + 1), "type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "z" * 30000}]}}),
    c({"timestamp": iso(CT0 + 2), "type": "response_item", "payload": {"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "<environment_context>\n<cwd>/w</cwd>\n</environment_context>"},
        {"type": "input_text", "text": "Review the patch in /tmp/r1.diff for bugs."}]}}),
    c({"timestamp": iso(CT0 + 3), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 12000}}}}),
    c({"timestamp": iso(CT0 + 4), "type": "response_item", "payload": {"type": "reasoning", "summary": [
        {"type": "summary_text", "text": "**Inspecting the allocator**\n\nI'll look at how reserved keys are handled."}], "encrypted_content": "QUFB" * 50000}}),
    c({"timestamp": iso(CT0 + 5), "type": "response_item", "payload": {"type": "function_call", "name": "exec_command",
        "arguments": json.dumps({"cmd": 'rg -n "reserved(" src/', "workdir": "/w"}), "call_id": "c1"}}),
    c({"timestamp": iso(CT0 + 6), "type": "response_item", "payload": {"type": "function_call_output", "call_id": "c1", "output": 'src/a.rs:1: "reserved"\n' * 20000}}),
    c({"timestamp": iso(CT0 + 20), "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [
        {"type": "output_text", "text": "Looking closer at the level 3 matcher."}], "phase": "commentary"}}),
    c({"timestamp": iso(CT0 + 30), "type": "response_item", "payload": {"type": "custom_tool_call", "name": "apply_patch",
        "input": "*** Begin Patch\n*** Update File: src/terms.rs\n@@\n-a\n+b\n*** Add File: src/new.rs\n+x\n*** End Patch", "call_id": "c2"}}),
    c({"timestamp": iso(CT0 + 31), "type": "response_item", "payload": {"type": "web_search_call", "action": {"type": "search", "query": "pthread_cond_timedwait spurious wakeup"}}}),
    c({"timestamp": iso(CT0 + 40), "type": "response_item", "payload": {"type": "function_call", "name": "shell",
        "arguments": json.dumps({"command": ["bash", "-lc", "cargo test -q\necho done"]}), "call_id": "c3"}}),
    c({"timestamp": iso(CT0 + 78), "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 53200}}}}),
    c({"timestamp": iso(CT0 + 79), "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [
        {"type": "output_text", "text": "## Findings\n- an off-by-one in `parse`"}], "phase": "final_answer"}}),
]
d = os.path.join(home, ".codex/sessions", time.strftime("%Y/%m/%d", time.gmtime(CT0)))
os.makedirs(d)
with open(os.path.join(d, f"rollout-{time.strftime('%Y-%m-%dT%H-%M-%S', time.gmtime(CT0 + 1))}-{SID}.jsonl"), "w") as f:
    f.write("\n".join(cl) + "\n")


# kimi: Python json.dumps with default separators (", ", ": "), ensure_ascii=False.
# A metadata line, then {timestamp: seconds, message: {type, payload}} a line.
def k(o):
    return json.dumps(o, ensure_ascii=False)


def rec(dt, typ, payload):
    return k({"timestamp": T0 + dt, "message": {"type": typ, "payload": payload}})


kl = [
    k({"type": "metadata", "protocol_version": "1.3"}),
    rec(2, "TurnBegin", {"user_input": [{"type": "text", "text": "Review the staged changes for false positives.\nFocus on level 2."}]}),
    rec(3, "StepBegin", {"n": 1}),
    rec(4, "ContentPart", {"type": "think", "think": "The user wants a review of staging. Let me read the plan first.\nThen the code."}),
    rec(5, "ToolCall", {"type": "function", "id": "tc1", "function": {"name": "ReadFile", "arguments": json.dumps({"path": "docs/plan.md"})}}),
    # A decoy: `"is_error": true` inside the output text, escaped as real output is.
    rec(6, "ToolResult", {"tool_call_id": "tc1", "return_value": {"is_error": False, "output": 'line "with" quotes, "is_error": true inside\n' * 30000, "message": "", "display": []}}),
    rec(7, "StatusUpdate", {"context_tokens": 9000, "token_usage": {"input_other": 9000, "output": 300, "input_cache_read": 0, "input_cache_creation": 0}}),
    rec(8, "StepBegin", {"n": 2}),
    rec(9, "ContentPart", {"type": "text", "text": "I'll run the detector tests."}),
    rec(10, "ToolCall", {"type": "function", "id": "tc2", "function": {"name": "Shell", "arguments": json.dumps({"command": "pytest -q tests/test_detect.py"})}}),
    rec(70, "ToolResult", {"tool_call_id": "tc2", "return_value": {"is_error": True, "output": "1 failed", "message": "exit 1", "display": []}}),
    rec(71, "StatusUpdate", {"token_usage": {"input_other": 1200, "output": 800, "input_cache_read": 9000, "input_cache_creation": 0}}),
    rec(72, "StepBegin", {"n": 3}),
    rec(80, "ContentPart", {"type": "text", "text": "**Verdict:** two real problems.\n\n1. T9 "}),
    rec(81, "ContentPart", {"type": "text", "text": "fires on aliases."}),
    rec(82, "TurnEnd", {}),
]
h = hashlib.md5("/w".encode()).hexdigest()
d = os.path.join(home, ".kimi/sessions", h, KID)
os.makedirs(d)
with open(os.path.join(d, "wire.jsonl"), "w") as f:
    f.write("\n".join(kl) + "\n")
# Another session in another folder, begun at the same moment: the run's folder decides.
d2 = os.path.join(home, ".kimi/sessions", "0" * 32, "aaaaaaaa-0000-4000-8000-000000000000")
os.makedirs(d2)
with open(os.path.join(d2, "wire.jsonl"), "w") as f:
    f.write("\n".join([kl[0], rec(1, "TurnBegin", {"user_input": "something else"}), rec(2, "TurnEnd", {})]) + "\n")

with open(os.path.join(home, "meta.json"), "w") as f:
    json.dump({"T0": T0, "CT0": CT0, "SID": SID, "KID": KID}, f)
print(f"wrote {home}", file=sys.stderr)
