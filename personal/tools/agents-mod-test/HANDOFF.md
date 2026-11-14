# Handoff: the sub-agent conversation window doesn't find codex's and kimi's logs

For: Claude Code running on the user's machine, which has the real `~/.codex`,
`~/.kimi`, `hc`, and this checkout (`erosca/herdr-app`, branch
`claude/charming-sagan-deb1x6`). The previous session ran in a cloud sandbox
without those files. It built and tested this feature against fixture logs.
On the real machine the logs aren't found. Your job: find out why from the
real files, fix it, and test it.

## 1. The feature (what should happen)

Herdr's agents sidebar (the shipped mod `defaults/mods/agents/`) lists finished
sub-agents: terminals that an agent (Claude Code) started with `hc run`.
Clicking one opens a **conversation window**:
- one round per request;
- each round has the request in a quoted block, a folded line
  "Worked 3m 12s · 14 steps · 41.2k tokens" that opens the list of steps, and
  the final answer as Markdown.

The rounds come, best first, from:

1. **Labels** the parent set: `herdr.request=<file>`, `herdr.answer=<file>`,
   `herdr.session=<id>`.
2. **The agent's own session log**, which holds everything:
   - **codex:** `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`;
   - **kimi:** `~/.kimi/sessions/<md5 of its folder>/<session id>/wire.jsonl`.
   - The session is found from the id on the command line
     (`codex exec resume <uuid>`, `kimi -r <id>`). Failing that, for codex, by
     `session id: <uuid>` in the terminal text; failing that, by folder and
     start time.
3. **Fallback:** the command line and the last 1000 lines of terminal output
   (herdr-core's cap for finished terminals).

## 2. The symptom

Two runs, `review-codex` and `review-kimi`, were started by Claude Code at
03:38 and ran 30m 38s and 25m 11s. Both windows show only the fallback:

- **"The request wasn't recorded."** No label, no log match, and no prompt
  readable from argv. That points to the prompt arriving via `sh -c '…'`,
  stdin, or a file.
- **"Output (no separate answer was recorded)"** above the terminal text.
- **No steps and no tokens.** So neither session log was matched or read at
  all. Even a cut-off read would have yielded the request, which sits at the
  log's start.

The header shows the correct codex and kimi icons, so the run records carry
`program.key` "codex" / "kimi". Verify that, though (hypothesis A).

## 3. Code map

- `defaults/mods/agents/main.js` is the sidebar.
  - `loadDone()` runs `hc ls --all --json`, which prints a **short form** with
    no argv, labels or times. It then fetches each finished sub-agent's full
    record once with `hc get <address> --json` (`fullRecord` in thread.js).
  - `threadsOf` groups runs into conversations by parent plus name, or by
    session label.
  - `openThread()` opens the window via
    `openOverlay({mod:"agents", kind:"dialog", width:0.8, height:0.8, props:{thread, runs, live}})`.
    Props cross as plain JSON, with `undefined` becoming `null`.
- `defaults/mods/agents/thread.js` is the data layer. Read it first.
  - `agentOf(run)`: "codex", "kimi" or null, from `program.key`, else from the
    first 4 argv entries.
  - `sessionFromArgv(argv, agent)`.
  - `requestFromArgv(argv, agent)`.
  - `readRollout(text)` (codex) and `readWire(text)` (kimi) turn a log's text
    into rounds `{at, request, answer, steps, work:[{at, kind, text, detail, error}], tokens, end}`.
  - **`codexLog(id)`** runs the shell script `CODEX_LOG`: find, then cat or
    zstd, then `grep -v` to drop `_call_output"`, `"type":"turn_context"` and
    `"role":"developer"` lines, then `sed` to blank `encrypted_content`.
  - **`codexMatch(run)`** finds rollouts with `-newermt @(created-120s)`, reads
    each one's first line (`session_meta`), and **requires
    `payload.cwd === run.cwd` exactly** and a timestamp within 90 s.
  - **`kimiLog(id)`** runs `KIMI_LOG`: find `*/<id>/wire.jsonl` 3 levels under
    the sessions root, then `sed` that replaces ToolResult lines with a tiny
    `{tool_call_id, is_error}`. **The pattern assumes Python
    `json.dumps` spacing**: `"type": "ToolResult", "payload"`.
  - **`kimiMatch(run)`** runs `KIMI_FIND`: the md5 of the cwd, and each
    `wire.jsonl` newer than created-120s with its TurnBegin timestamps.
    **The grep assumes `"type": "TurnBegin"` with a space** and
    `{"timestamp": <float>, ...` first. Any TurnBegin within 120 s matches; a
    session in the run's own folder wins.
  - `loadConversation(runs, live)` ties these together. **Every failure is
    swallowed silently** (try/catch) and falls back to the terminal.
- `defaults/mods/agents/conversation.js` is the view (header, rounds, steps
  list, keys). `util.js` holds small helpers.

Host facts, from the app's source:
- `exec(cmd, args)` runs the program directly with the user's environment, up
  to **30 s**. It reads at most **8 MiB of stdout and silently truncates** the
  rest: `src/mods.rs`, `run_blocking`, `take(EXEC_OUTPUT)`.
- `readTextFile` reads at most 1 MiB.
- `console.log` goes to the app's stderr (tracing target
  `gpui_shell::script`), which a menu-started Herdr loses. Show diagnostics in
  the window instead (section 6).

## 4. Hypotheses, most likely first

**A. `agentOf` returns null.** Then no log is even looked for.
- The prompt not being in argv suggests `sh -c`. Then
  `argv = ["sh","-c","codex exec …"]`, which the argv check doesn't match.
- That leaves `run.program.key`, which comes from the sidebar's remembered
  program (`this.progs`).
- Check in the window: what `run.program` and `run.argv` arrive in `props().runs`.

**B. codex: `codexMatch` misses.**
- *Folder mismatch:* `cwd` must equal exactly. codex reports
  `getcwd()`, which resolves symlinks, and `codex -C/--cd <dir>` changes it.
  herdr-core records the folder `hc run` was given.
- *Late start:* the `sh -c` script may do work first, pushing codex's start
  past 90 s.
- *First line:* the first line isn't `session_meta`.
- *`CODEX_HOME`:* if it's set, the sessions aren't in `~/.codex`.

**C. codex: the log is found but its reading is cut.** The 8 MiB cap is
silent. Even after filtering, a 30-minute session keeps:
- `"type":"compacted"` lines, which can hold whole replacement histories;
- `event_msg` lines other than `token_count` (in paginated history mode, item
  events with command output up to 64 KB each).

That cuts off the end, the final answer. Note that it wouldn't explain the
missing *request*, so A or B is likelier for the codex window.

**D. kimi: format or layout differs from kimi-cli 9ab1286** (2026-09-22,
the version read).
- *Spacing:* compact JSON with no spaces breaks the TurnBegin grep and the
  ToolResult sed.
- *Layout:* an older or newer layout (e.g. `sessions/<hash>/<id>.jsonl`, no
  `wire.jsonl`).
- *Location:* `KIMI_SHARE_DIR`.
- *Folder hash:* md5 of a different path string. This only affects
  preference, not matching.

**E. Time window.** For kimi, a TurnBegin more than 120 s from the run's
`created_ms`.

## 5. Diagnose with the real files

Look at shapes, not contents. Don't paste the user's review text anywhere it
doesn't need to go.

```bash
# The two runs: argv, cwd, times, labels (addresses from the first command)
hc ls --all --json | jq -r '.terminals[] | select(.name // "" | test("review-")) | "\(.address) \(.name) \(.state)"'
hc get <address> --json | jq '{argv, cwd, created_ms, finished_ms, labels, parent}'

# codex: candidate logs around the run, and each one's first line's shape
echo "${CODEX_HOME:-$HOME/.codex}"
find "${CODEX_HOME:-$HOME/.codex}/sessions" -name 'rollout-*' -newermt '<run start minus 5 min>' | head
head -n 1 <rollout> | jq '{type, id: .payload.id, cwd: .payload.cwd, ts: .payload.timestamp}'
ls -l <rollout>; grep -c '"type":"response_item"' <rollout>; grep -c '"type":"compacted"' <rollout>
grep -o '"type":"[a-z_]*"' <rollout> | sort | uniq -c | sort -rn | head -20
# what the mod's reader would get (bytes; compare against the 8 MiB cap)
sh -c "$(node -e 'const s=require("fs").readFileSync("defaults/mods/agents/thread.js","utf8");process.stdout.write(s.match(/const CODEX_LOG = String.raw`([^`]*)`/)[1])')" sh <uuid> "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" | wc -c

# kimi: version, layout, line shape
kimi --version; echo "${KIMI_SHARE_DIR:-$HOME/.kimi}"
find "${KIMI_SHARE_DIR:-$HOME/.kimi}/sessions" -maxdepth 3 -newermt '<run start minus 5 min>' | head
head -c 200 <wire.jsonl>; echo; grep -m1 -o '^.\{0,80\}TurnBegin' <wire.jsonl>
printf '%s' '<run cwd>' | md5sum
```

Then run the mod's own functions against the real files. The harness can do
this: point `HOME_DIR` at the real home and pass a real run record (see section 7).

## 6. Fixes to make (whatever the root cause)

1. **Codex: keep only what's parsed.** Use a positive filter, which also
   removes the cap problem:
   `grep -E '"type": *"(session_meta|response_item)"|"type": *"token_count"'`,
   then drop `_call_output"`, then blank `encrypted_content`.
2. **Kimi: tolerate any spacing.** Write every pattern as `"key": *"value"`.
   After the ToolResult `sed` substitution, delete ToolResult lines it couldn't
   reduce (`s/…/…/;t;d` inside the address block). Keep only the message types
   that are parsed: `TurnBegin|SteerInput|StepBegin|ContentPart|ToolCall|ToolResult|StatusUpdate|TurnEnd`.
3. **Codex discovery:**
   - honor `CODEX_HOME`;
   - prefer a folder match but don't require it (compare `realpath` of both
     sides);
   - widen the start window to a few minutes, preferring the closest;
   - if a candidate's first line isn't `session_meta`, scan for it.
4. **Kimi discovery:** support whatever layout the installed version uses, if
   it differs.
5. **`agentOf`:** also look inside an `sh -c` script (`argv[2]`) for
   `\bcodex\b` / `\bkimi\b`. Take the session id and prompt from it where
   possible.
6. **Say why in the window.** When a codex or kimi run has no log match, show
   one dim line under the request: where it looked and what it found. For
   example: "No codex session started 03:36–03:41 in ~/.codex/sessions
   (2 sessions from other folders)". `loadConversation` can return a `note`
   per round. That also makes the next failure diagnosable from a screenshot.
7. **Don't swallow silently** when something unexpected happens. Keep the
   fallback, but record the error text in that note.

## 7. Test

- **Harness:** in `personal/tools/agents-mod-test/`, run
  `python3 make-fixtures.py && node harness.mjs ../../../defaults/mods/agents .`.
  It loads the mod's four modules with stubbed `gpui-kit` / `gpui-base` /
  `herdr` modules and checks 68 behaviors. The log tests run the real shell
  scripts on the fixture logs (`fixhome/`), and the harness fails if the mod
  calls an element method gpui-kit doesn't have (`allowed.txt`, `shipped.txt`).
- **Add a fixture per real shape you find:** sanitized, with the real line
  format and spacing and the real file layout. Each fix needs a check that
  failed before it.
- **Iterate in the app without rebuilding:** edit
  `~/.config/herdr-app/mods/agents/*.js` directly. Saving hot-reloads it, and
  `herdr-app status` shows mod errors. The next start replaces the installed
  copy with the shipped one (keeping yours as `agents-edited`), so port the
  final change to `defaults/mods/agents/` in the repo.
- **Before calling it done:** `herdr-app check ~/.config/herdr-app/mods/agents`
  must pass. Rebuild with `personal/setup.sh` (add `--nomachine` on the
  NoMachine desktop), restart Herdr, and open both windows again.

## 8. Repo rules

- Commit on `claude/charming-sagan-deb1x6` and push there.
- Commit messages: lowercase conventional commits, one line, no AI co-author
  lines (repo `AGENTS.md`).
- A change to what users or agents can do updates `defaults/AGENTS.md` in the
  same commit. See its "Sub-agents" paragraph, which describes this window.
- Don't stop or restart the user's Herdr or herdr-core yourself; ask.

## 9. Done when

- The `review-codex` and `review-kimi` windows show each request, the steps,
  the tokens and the final answer from the logs, with no labels needed.
- A run whose log can't be found says why, in one line.
- The harness passes, with new fixtures for the real formats found, and
  `herdr-app check` passes.
