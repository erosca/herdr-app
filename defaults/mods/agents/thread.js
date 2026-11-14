// A sub-agent's conversation: what its parent asked, what it did and what it answered,
// round by round, from the best source each run has:
//   1. labels its parent set: herdr.request=<file>, herdr.answer=<file>, herdr.session=<id>;
//   2. the agent's own session log, on the machine the run was on, nothing cut:
//      codex's ($CODEX_HOME or ~/.codex, sessions/**/rollout-<time>-<id>.jsonl[.zst]) or
//      Kimi Code's ($KIMI_CODE_HOME or ~/.kimi-code,
//      sessions/<folder>/<session id>/agents/main/wire.jsonl): the request, each step
//      (what it ran, read, edited and said), the final answer, the tokens;
//   3. the terminal: its command line and the last 1000 lines herdr-core keeps.
// A run's log is the session named on its command line, else the one in the run's
// folder with a turn that began while the run was alive. A run still going is read the
// same way, and read on from where the last look ended (liveSteps).

import { hc, exec, readTextFile } from "herdr";

// The session id in a run's output: as codex prints it, or as a line `session <id>`.
const CODEX_SESSION = /(?:session id:|^session)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/im;
// Text codex adds to a user turn itself: environment, AGENTS.md, skills, notices.
const CONTEXT = /^\s*(<(?!stdin\b)[A-Za-z_][\w-]*[\s>]|# AGENTS\.md instructions)/;

const uniq = (xs) => [...new Set(xs.filter(Boolean))];
const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const label = (run, key) => run.labels?.[key] || null;
// Session ids go into find patterns: only these shapes do.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIMI_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = { codex: UUID, kimi: KIMI_ID };
const NAME = { codex: "Codex", kimi: "Kimi" };

const LAUNCHER = /^(env|timeout|nice|nohup|stdbuf|time|script|sudo)$/;
const isScript = (argv) => argv.length > 2 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && /^-\w*c$/.test(argv[1]);
// The words to look at: a shell script's, else the arguments as they are.
const words = (argv) => (!Array.isArray(argv) ? [] : isScript(argv) ? argv[2].split(/[\s;|&()'"=]+/) : argv);

/** "codex", "kimi", or null: whose session log a run left. */
export function agentOf(run) {
  const key = run.program?.key ?? "";
  if (key === "codex") return "codex";
  if (/^kimi/.test(key)) return "kimi";
  // Else by its command line: the program; a shell script's words; after a launcher or a
  // wrapper script, its first arguments (`run-reviewer.sh codex ...`). Not any argument:
  // `grep codex notes.md` isn't codex.
  const argv = Array.isArray(run.argv) ? run.argv : [];
  const first = (argv[0] ?? "").split("/").pop();
  const wrapped = LAUNCHER.test(first) || /\.\w+$/.test(first);
  for (const w of isScript(argv) ? words(argv) : argv.slice(0, wrapped ? 4 : 1)) {
    const base = w.split("/").pop();
    if (base === "codex") return "codex";
    if (base === "kimi" || base === "kimi-code") return "kimi";
  }
  return null;
}

// A follow-up names its session (`codex exec resume <id>`, `kimi -S <id>`), also through
// a wrapper: any argument shaped like that agent's session ids.
function sessionFromArgv(argv, agent) {
  return (ID[agent] && words(argv).find((a) => ID[agent].test(a))) || null;
}

// What ties runs into one conversation: the same parent and name (a follow-up reuses
// the name), or the same session. A run with neither name nor session stands alone.
function threadKeys(k) {
  const keys = [];
  const name = k.name || k.template;
  if (name) keys.push(`${k.parent}\u0000n\u0000${name}`);
  const session = label(k, "herdr.session");
  if (session) keys.push(`${k.parent}\u0000s\u0000${session}`);
  return keys.length ? keys : [`a\u0000${k.address}`];
}

const byStart = (x, y) => (x.created_ms ?? 0) - (y.created_ms ?? 0);

/** Runs grouped into conversations, each { runs } oldest first. */
export function groupThreads(runs) {
  const byKey = new Map();
  const threads = [];
  for (const k of [...runs].sort(byStart)) {
    const keys = threadKeys(k);
    let th = null;
    for (const key of keys) {
      const found = byKey.get(key);
      if (!found || found === th) continue;
      if (!th) {
        th = found;
        continue;
      }
      // This run ties two conversations together (a name and a session): one now.
      th.runs.push(...found.runs);
      for (const [key2, v] of byKey) if (v === found) byKey.set(key2, th);
      threads.splice(threads.indexOf(found), 1);
    }
    if (!th) {
      th = { runs: [] };
      threads.push(th);
    }
    th.runs.push(k);
    for (const key of keys) byKey.set(key, th);
  }
  for (const th of threads) th.runs.sort(byStart);
  return threads;
}

/** What the conversation window needs to find a thread's runs again: { parent, names, sessions, addresses }. */
export function threadOf(runs) {
  return {
    parent: runs[0]?.parent ?? null,
    names: uniq(runs.map((k) => k.name || k.template)),
    sessions: uniq(runs.map((k) => label(k, "herdr.session"))),
    addresses: runs.map((k) => k.address),
  };
}

export function belongs(th, k) {
  if (th.addresses?.includes(k.address)) return true;
  if (!k.parent || k.parent !== th.parent) return false;
  const name = k.name || k.template;
  const session = label(k, "herdr.session");
  return Boolean((name && th.names?.includes(name)) || (session && th.sessions?.includes(session)));
}

// What this file asks of the app, one thing at a time: ["hc", args], ["sh", script,
// args, machine] or ["file", path, machine]. Its work is written as steps that yield
// such a request and get the answer back, so the same steps run in the app (`drive`)
// and, in tests, against answers recorded from real runs.
const HOST = {
  hc: (args) => hc(args),
  sh: (script, args, on) => exec("sh", ["-c", script, "sh", ...args], on ? { on } : {}),
  file: (path, on) => readTextFile(path, on ? { on } : {}),
};

async function drive(steps) {
  let r = steps.next();
  while (!r.done) {
    const [kind, ...args] = r.value;
    let answer;
    try {
      answer = await HOST[kind](...args);
    } catch (e) {
      r = steps.throw(e);
      continue;
    }
    r = steps.next(answer);
  }
  return r.value;
}

// `hc ls --json` lists a short form of each terminal, without its command line, labels
// or times: the whole record comes from `hc get`. A finished one doesn't change.
export function* recordSteps(k) {
  if (Array.isArray(k.argv) && k.created_ms != null) return k;
  try {
    const r = yield ["hc", ["get", k.address, "--json"]];
    if (r.code !== 0) return k;
    const full = JSON.parse(r.stdout);
    // The list's address and parent say which machine; keep them as the list has them.
    return { ...k, ...full, address: k.address, parent: k.parent ?? full.parent ?? null, program: k.program ?? null };
  } catch (_) {
    return k;
  }
}

export const fullRecord = (k) => drive(recordSteps(k));

// The prompt on the command line: kimi's -p/--prompt value, else the longest argument
// that reads like a sentence (codex's prompt). Null for a shell script (`sh -c ...`),
// whose prompt can't be told from the rest, and for a prompt fed on stdin or from a file.
export function requestFromArgv(argv, agent = null) {
  if (!Array.isArray(argv) || isScript(argv)) return null;
  if ((agent ?? agentOf({ argv })) === "kimi") {
    const i = argv.findIndex((a) => a === "-p" || a === "--prompt");
    if (i > 0 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith("--prompt="));
    if (eq) return eq.slice(eq.indexOf("=") + 1);
  }
  const said = argv.slice(1).filter((a) => /\s/.test(a) && a.length >= 20);
  return said.sort((x, y) => y.length - x.length)[0] ?? null;
}

// Steps: { at, kind, text, detail?, error?, ms? }. kind: think (what it set out to do),
// say (what it told along the way), run, read, edit, search, fetch, plan, tool.
// error: true, or a word for it ("exit 1"). ms: how long it took. `detail` is the whole
// of it where `text` is its first line: a whole command, what was said in full.
const SAID = 20000;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function step(at, kind, full, detail = null) {
  const all = String(full ?? "").trim();
  const one = firstLine(all);
  const text = clip(one, 240) + (all.includes("\n") && one.length <= 240 ? " …" : "");
  const more = String(detail ?? all).trim();
  return { at, kind, text, detail: more && more !== text ? clip(more, kind === "say" ? SAID : 1500) : null };
}

/** A thought's headline: its bold title, else its first line. */
export function headline(text) {
  const t = String(text ?? "");
  const bold = t.match(/\*\*([^*\n]+)\*\*/);
  return clip((bold ? bold[1] : firstLine(t)).trim(), 160);
}

function parseArgs(s) {
  if (s && typeof s === "object") return s;
  try {
    return JSON.parse(s || "{}") ?? {};
  } catch (_) {
    return {};
  }
}

function shellText(a) {
  if (typeof a.cmd === "string") return a.cmd;
  if (typeof a.command === "string") return a.command;
  if (Array.isArray(a.command)) {
    const c = a.command;
    // ["bash", "-lc", "rg -n foo"]: the script is what it ran.
    return isScript(c) ? c.slice(2).join(" ") : c.join(" ");
  }
  return null;
}

// A path as the agent's folder sees it.
const within = (path, cwd) => (cwd && typeof path === "string" && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
const byTime = (x, y) => (x.at ?? 0) - (y.at ?? 0);

const patchPaths = (patch) => [...String(patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

// A tool call of a codex that doesn't log what its calls did (before 0.167): a step's
// { kind, text }, or null for plumbing.
function codexCall(p) {
  if (p.type === "local_shell_call") return { kind: "run", text: shellText(p.action ?? {}) ?? "a command" };
  if (p.type === "web_search_call") {
    const a = p.action ?? {};
    return { kind: "search", text: a.query ?? a.queries?.join(", ") ?? a.url ?? "the web" };
  }
  if (p.type === "custom_tool_call") {
    return p.name === "apply_patch" ? { kind: "edit", text: patchPaths(p.input).join(", ") || "a patch" } : { kind: "tool", text: p.name ?? "a tool" };
  }
  if (p.type !== "function_call") return null;
  const a = parseArgs(p.arguments);
  const name = p.name ?? "";
  if (name === "write_stdin") return null;
  if (/^(exec_command|shell|shell_command|container\.exec|local_shell)$/.test(name)) return { kind: "run", text: shellText(a) ?? name };
  if (name === "apply_patch") return { kind: "edit", text: patchPaths(a.input ?? a.patch).join(", ") || "a patch" };
  if (name === "update_plan") return { kind: "plan", text: `Updated its plan${Array.isArray(a.plan) ? ` (${a.plan.length} steps)` : ""}` };
  if (name === "view_image") return { kind: "read", text: a.path ?? "an image" };
  return { kind: "tool", text: p.namespace ? `${p.namespace}.${name}` : name || "a tool" };
}

const CHANGED = { add: " (new)", delete: " (deleted)" };

// What a codex call did, as codex logs it once done (`item_completed`): a step, or null.
function codexItem(it, at, cwd) {
  let s = null;
  if (it.type === "CommandExecution") {
    const parsed = Array.isArray(it.parsed_cmd) ? it.parsed_cmd : [];
    const script = shellText(it) ?? parsed.map((c) => c.cmd).join(" && ");
    const kinds = uniq(parsed.map((c) => c.type));
    // codex says what a command amounts to: reading files or searching reads better than `sed -n 1,200p`.
    if (kinds.length === 1 && kinds[0] === "read") s = step(at, "read", uniq(parsed.map((c) => within(c.path ?? c.name, cwd))).join(", "), script);
    else if (kinds.length === 1 && kinds[0] === "search") s = step(at, "search", uniq(parsed.map((c) => [c.query, within(c.path, cwd)].filter(Boolean).join(" in "))).join(", "), script);
    else s = step(at, "run", script);
    if (it.exit_code != null && it.exit_code !== 0) s.error = `exit ${it.exit_code}`;
    else if (it.status === "failed" || it.status === "declined") s.error = it.status;
    const d = it.duration;
    if (d && typeof d === "object") s.ms = Math.round((d.secs ?? 0) * 1000 + (d.nanos ?? 0) / 1e6);
  } else if (it.type === "FileChange") {
    const files = Object.entries(it.changes ?? {}).map(([path, c]) => `${within(path, cwd)}${CHANGED[c?.type] ?? ""}`);
    s = step(at, "edit", files.join(", ") || "files");
    if (it.status === "failed" || it.status === "declined") s.error = it.status;
  } else if (it.type === "McpToolCall") {
    const what = it.arguments?.url ?? it.arguments?.query ?? it.arguments?.path;
    s = step(at, "tool", [`${it.appName ?? it.server ?? "MCP"}: ${it.actionName ?? it.tool ?? "a tool"}`, typeof what === "string" ? what : null].filter(Boolean).join(" "));
    if (it.status === "failed") s.error = true;
  } else if (it.type === "Extension" && it.kind === "web.search") {
    const a = it.action ?? {};
    if (a.type === "search") s = step(at, "search", a.query ?? a.queries?.join(", ") ?? it.query ?? "the web");
    else s = step(at, "fetch", [a.pattern, a.url].filter(Boolean).join(" in ") || it.query || "a page");
  } else if (it.type === "ContextCompaction") {
    s = step(at, "plan", "Made room in its memory (compacted its context)");
  }
  return s;
}

/** codex's session log, or the part of it from one run: requests start rounds; steps, answers and tokens fill them. */
export function readRollout(text, { cwd = null } = {}) {
  const out = { rounds: [] };
  let round = null;
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const p = r.payload ?? {};
    const at = Date.parse(r.timestamp) || null;
    if (r.type === "event_msg") {
      if (!round) continue;
      if (p.type === "token_count") {
        // One count for each answer of the model: what it read anew and wrote, and what came from cache.
        const u = p.info?.last_token_usage;
        if (!u) continue;
        const cached = u.cached_input_tokens ?? 0;
        round.tokens += Math.max(0, (u.input_tokens ?? 0) - cached) + (u.output_tokens ?? 0);
        round.cached += cached;
      } else if (p.type === "item_completed" && p.item) {
        round.logged = true;
        const s = codexItem(p.item, p.started_at_ms ?? at, cwd);
        if (s) round.items.push(s);
        if (at != null) round.end = at;
      } else if (p.type === "task_complete" || p.type === "turn_complete" || p.type === "turn_aborted") {
        // The turn is over: what it said last is its answer.
        round.done = true;
        if (at != null) round.end = at;
        if (p.type === "turn_aborted") round.ended = round.ended ?? (typeof p.reason === "string" ? p.reason : "stopped");
      }
      continue;
    }
    if (r.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      // codex marks what it added itself (environment, instructions); older logs are told by their text.
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      const parts = (p.content ?? []).filter((c) => c.type === "input_text" && c.text);
      const marked = Array.isArray(kinds) && kinds.length === (p.content ?? []).length;
      const asked = (marked ? (p.content ?? []).filter((c, i) => kinds[i] === "user.text" && c.type === "input_text" && c.text) : parts.filter((c) => !CONTEXT.test(c.text)))
        .map((c) => c.text.trim())
        .filter(Boolean)
        .join("\n\n");
      // A resumed session's files can repeat earlier turns.
      if (!asked || seen.has(`${at}\u0000${asked}`)) continue;
      seen.add(`${at}\u0000${asked}`);
      round = { at, request: asked, answer: null, final: false, notes: [], calls: [], items: [], logged: false, tokens: 0, cached: 0, end: at };
      out.rounds.push(round);
      continue;
    }
    if (!round) continue;
    if (at != null) round.end = at;
    if (p.type === "message" && p.role === "assistant") {
      const said = (p.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("").trim();
      if (!said) continue;
      if (p.phase === "commentary") round.notes.push(step(at, "say", said));
      else if (p.phase === "final_answer") {
        round.answer = said;
        round.final = true;
      } else if (!round.final) {
        // No phases (older models): every message but the last was said along the way.
        if (round.answer) round.notes.push(step(round.answerAt, "say", round.answer));
        round.answer = said;
        round.answerAt = at;
      }
    } else if (p.type === "reasoning") {
      for (const s of p.summary ?? []) if (s?.text?.trim()) round.notes.push(step(at, "think", headline(s.text), s.text));
    } else if (/_call$/.test(p.type ?? "")) {
      const s = codexCall(p);
      if (s) round.calls.push(step(at, s.kind, s.text));
    }
  }
  return { rounds: out.rounds.map((r) => finish(r, r.logged ? r.items : r.calls)) };
}

// A round as the window takes it: its steps in order, counted without the talk. `done`:
// its turn is over (a run still going has one that isn't).
function finish(r, did) {
  const work = [...r.notes, ...did].sort(byTime);
  return { at: r.at, end: r.end, request: r.request, answer: r.answer, work, steps: did.length,
    tokens: r.tokens || null, cached: r.cached || null, ended: r.ended ?? null, done: Boolean(r.done || r.final) };
}

const TOOLS = { Bash: "run", Shell: "run", Read: "read", ReadFile: "read", ReadMediaFile: "read", Write: "edit", WriteFile: "edit", Edit: "edit",
  StrReplaceFile: "edit", MultiEdit: "edit", Grep: "search", Glob: "search", WebSearch: "search", SearchWeb: "search", WebFetch: "fetch", FetchURL: "fetch",
  TodoList: "plan", SetTodoList: "plan", Think: "think" };

// One Kimi Code tool call as a step.
function kimiCall(ev, at, cwd) {
  const a = parseArgs(ev.args);
  const d = ev.display ?? {};
  // Tools it doesn't name here go by how Kimi itself shows them.
  const kind = TOOLS[ev.name] ?? (d.kind === "command" ? "run" : d.kind === "file_io" ? (d.operation === "read" ? "read" : "edit") : d.kind === "todo_list" ? "plan" : "tool");
  const path = within(a.path ?? d.path, cwd);
  if (kind === "run") return step(at, kind, a.command ?? d.command ?? ev.name);
  if (kind === "read" || kind === "edit") return step(at, kind, path ?? ev.name);
  if (kind === "search") return step(at, kind, [a.pattern ?? a.query, path].filter(Boolean).join(" in ") || ev.name);
  if (kind === "fetch") return step(at, kind, a.url ?? ev.name);
  if (kind === "plan") return step(at, kind, `Updated its to-do list${Array.isArray(a.todos) ? ` (${a.todos.length} items)` : ""}`);
  if (kind === "think") return step(at, kind, headline(a.thought), a.thought);
  return step(at, "tool", ev.name ?? "a tool");
}

/** Kimi Code's wire.jsonl, or the part of it from one run: { type, ..., time: ms } a line. */
export function readWire(text, { cwd = null } = {}) {
  const rounds = [];
  let round = null;
  let said = ""; // the text of the step in progress: the answer, if it's the last
  let saidAt = null;
  const calls = new Map();
  const keepSaid = () => {
    if (round && said.trim()) round.notes.push(step(saidAt, "say", said));
    said = "";
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const at = typeof r.time === "number" ? r.time : null;
    if (r.type === "turn.prompt") {
      if (round && !round.done) keepSaid();
      said = "";
      const asked = (Array.isArray(r.input) ? r.input : []).filter((c) => c?.type === "text" && c.text).map((c) => c.text).join("\n").trim();
      round = { at, request: asked || null, answer: null, notes: [], did: [], tokens: 0, cached: 0, end: at, done: false };
      rounds.push(round);
      continue;
    }
    if (!round || round.done) continue;
    if (at != null) round.end = at;
    if (r.type === "turn.ended") {
      // The last step's text is the answer.
      round.answer = said.trim() || null;
      said = "";
      round.done = true;
      if (r.reason && r.reason !== "completed") round.ended = r.reason;
      continue;
    }
    const ev = r.type === "context.append_loop_event" ? r.event : null;
    if (!ev) continue;
    if (ev.type === "step.begin") keepSaid();
    else if (ev.type === "content.part") {
      const part = ev.part ?? {};
      if (part.type === "text" && part.text) {
        if (!said) saidAt = at;
        said += part.text;
      } else if (part.type === "think" && part.think?.trim()) round.notes.push(step(at, "think", headline(part.think), part.think));
    } else if (ev.type === "tool.call") {
      const s = kimiCall(ev, at, cwd);
      (s.kind === "think" ? round.notes : round.did).push(s);
      if (ev.toolCallId) calls.set(ev.toolCallId, s);
    } else if (ev.type === "tool.result") {
      const s = calls.get(ev.toolCallId);
      if (s && ev.result?.isError) s.error = true;
      if (s && typeof ev.result?.durationMs === "number") s.ms = ev.result.durationMs;
    } else if (ev.type === "step.end" && ev.usage) {
      const u = ev.usage;
      round.tokens += (u.inputOther ?? 0) + (u.inputCacheCreation ?? 0) + (u.output ?? 0);
      round.cached += u.inputCacheRead ?? 0;
    }
  }
  if (round && !round.done) keepSaid();
  return { rounds: rounds.map((r) => finish(r, r.did)) };
}

// Everything about a run's log happens on the machine the run was on: the scripts find
// that machine's own home, and send back only the lines read here, without what the
// tools printed (most of a log, and nothing shown).
const LIMIT = 4000000;
const TOO_LONG = "This run's log is longer than Herdr reads (4 MB): its end is missing.";
const sh = (run, script, args) => ["sh", script, args.map(String), machineOf(run.address)];

const CODEX_ROOT = String.raw`root=$CODEX_HOME; [ -n "$root" ] || root=$HOME/.codex
`;
// The folder as the machine resolves it, then for each session written to since $1:
// F <file>, the start of its first line (its folder), the start of each turn's line (its time).
const CODEX_FIND = CODEX_ROOT + String.raw`(cd "$2" 2>/dev/null && pwd -P) || echo
find "$root/sessions" -name "rollout-*.jsonl*" -newermt "@$1" 2>/dev/null | while IFS= read -r f; do
  case "$f" in *.zst) c="zstd -dcq";; *) c=cat;; esac
  printf 'F\t%s\n' "$f"
  $c "$f" 2>/dev/null | head -n 1 | cut -c1-3000
  $c "$f" 2>/dev/null | grep -E '"type":"(task_started|turn_started)"' | cut -c1-60
done`;

// A log still being written is read on from where the last look ended ($off, in
// bytes), and never a line in halves: `whole FILE` sets $size to FILE's length up to
// its last whole line, `part FILE` prints its bytes from $off to there. Each log script
// first prints `O <file> <size>`: where to read on from, next time.
const PART = String.raw`whole() {
  size=$(($({ wc -c < "$1"; } 2>/dev/null) + 0))
  [ "$size" -gt "$off" ] || return 0
  [ "$(tail -c +"$size" "$1" | head -c 1 | od -An -tu1 | tr -d ' \n')" = 10 ] ||
    size=$((size - $(tail -c +$((off + 1)) "$1" | head -c $((size - off)) | tail -n 1 | wc -c)))
}
part() { [ "$size" -gt "$off" ] && tail -c +$((off + 1)) "$1" | head -c $((size - off)); }
`;

// A session's lines between two times ($2, $3: as codex writes them), of the kinds read
// here. $5: the file to read on, or - to look for the session $1; $6: from which byte.
// A session in several files, or a packed one, is read whole and not read on.
const CODEX_LOG = CODEX_ROOT + PART + String.raw`f=$5; off=$6; all=; size=0
if [ "$f" = - ]; then
  f=$(find "$root/sessions" "$root/archived_sessions" -name "rollout-*$1*.jsonl*" 2>/dev/null | sort)
  case "$f" in *"
"*|*.zst) all=$f; f=;; esac
fi
[ -z "$f" ] || whole "$f"
printf 'O\t%s\t%s\n' "$f" "$size"
if [ -n "$f" ]; then part "$f"; else printf '%s\n' "$all" | while IFS= read -r g; do
  case "$g" in "") ;; *.zst) zstd -dcq "$g" 2>/dev/null;; *) cat "$g";; esac
done; fi |
awk -v a="$2" -v b="$3" '{ t = substr($0, 15, 24); if (t >= a && t <= b) print }' |
grep -E '^\{"timestamp":"[^"]*",("ordinal":[0-9]+,)?"type":"(response_item","payload":\{"type":"(message|reasoning|function_call|custom_tool_call|local_shell_call|web_search_call)"|event_msg","payload":\{"type":"(token_count|item_completed|task_complete|turn_complete|turn_aborted)")' |
grep -v -E '"payload":\{"type":"(message"(,"id":"[^"]*")?,"role":"developer"|reasoning"(,"id":"[^"]*")?,"summary":\[\])|"item":\{"type":"(Reasoning|UserMessage|AgentMessage)"' |
sed -E 's/"encrypted_content":"[^"]*"/"encrypted_content":null/g; s/"(aggregated_output|last_agent_message)":"(\\.|[^"\\])*"/"\1":""/g; /"item":\{"type":"(FileChange|McpToolCall|Extension)"/ s/"(content|unified_diff|snippet|text|stdout)":"(\\.|[^"\\])*"/"\1":""/g' |
head -c $4`;

const KIMI_ROOT = String.raw`root=$KIMI_CODE_HOME; [ -n "$root" ] || root=$HOME/.kimi-code; root=$root/sessions
`;
// As CODEX_FIND: F <session folder>, its state.json (its folder), the times its turns began.
const KIMI_FIND = KIMI_ROOT + String.raw`(cd "$2" 2>/dev/null && pwd -P) || echo
find "$root" -mindepth 5 -maxdepth 5 -path "*/agents/main/wire.jsonl" -newermt "@$1" 2>/dev/null | while IFS= read -r f; do
  d=$(dirname "$(dirname "$(dirname "$f")")")
  printf 'F\t%s\n' "$d"
  tr -d '\n' < "$d/state.json" 2>/dev/null | cut -c1-3000; echo
  grep '^{"type":"turn.prompt"' "$f" | sed -E 's/.*"time":([0-9]+)\}$/\1/' | tr '\n' ' '; echo
done`;

// A session's lines between two times ($2, $3: ms), of the kinds read here; $5 and $6
// as for codex.
const KIMI_LOG = KIMI_ROOT + PART + String.raw`f=$5; off=$6; size=0
[ "$f" != - ] || f=$(find "$root" -mindepth 5 -maxdepth 5 -path "*/$1/agents/main/wire.jsonl" 2>/dev/null | head -n 1)
[ -n "$f" ] || exit 3
whole "$f"
printf 'O\t%s\t%s\n' "$f" "$size"
part "$f" |
grep -E '^\{"type":"(turn\.prompt|turn\.ended|context\.append_loop_event)"' |
awk -v a="$2" -v b="$3" '{ if (match($0, /"time":[0-9]+\}$/)) { t = substr($0, RSTART + 7, RLENGTH - 8) + 0; if (t < a || t > b) next } print }' |
sed -E '/"event":\{"type":"tool\.result"/ s/"output":"(\\.|[^"\\])*"/"output":""/; /"event":\{"type":"tool\.call"/ s/"(content|old_string|new_string)":"(\\.|[^"\\])*"/"\1":""/g' |
head -c $4`;

// While a run was alive, give or take: a turn that began then is that run's. One still
// going has no end yet.
const NO_END = Date.UTC(2100, 0, 1);
const alive = (run) => [run.created_ms - 5000, run.finished_ms != null ? run.finished_ms + 5000 : NO_END];
const jsonString = (s) => { try { return JSON.parse(`"${s}"`); } catch (_) { return s; } };

// What a find script printed: the run's folder as its machine resolves it, and the
// sessions written to since the run began, each { id, cwd, starts }.
function candidates(out, read) {
  const [real, ...lines] = out.split("\n");
  const list = [];
  let c = null;
  for (const l of lines) {
    if (l.startsWith("F\t")) {
      c = { path: l.slice(2), id: null, cwd: null, starts: [], first: true };
      list.push(c);
    } else if (c) {
      read(c, l);
      c.first = false;
    }
  }
  return { real: real.trim() || null, list };
}

// The session a run left: in its folder, with a turn that began while it was alive;
// of several, the one that began nearest the run's start. { id, cwd } or { note }.
function pick(run, agent, { real, list }) {
  const [from, to] = alive(run);
  const here = list.filter((c) => c.id && c.cwd && (c.cwd === run.cwd || c.cwd === real));
  let best = null;
  for (const c of here) {
    for (const t of c.starts) {
      if (!(t >= from && t <= to)) continue;
      const off = Math.abs(t - run.created_ms);
      if (!best || off < best.off) best = { id: c.id, cwd: c.cwd, off };
    }
  }
  if (best) return { id: best.id, cwd: best.cwd };
  const where = machineOf(run.address) ? ` on ${machineOf(run.address)}` : "";
  const why = !list.length ? `no ${NAME[agent]} session was written to since it began`
    : !here.length ? `${list.length} ${NAME[agent]} ${list.length === 1 ? "session was" : "sessions were"} active then, none in this run's folder`
      : `the ${NAME[agent]} ${here.length === 1 ? "session" : "sessions"} in its folder took no request while it ran`;
  return { id: null, note: `${NAME[agent]}'s own log of this run wasn't found${where}: ${why}.` };
}

// Looks for a run's session on its machine: { id, cwd } or { note }.
const FIND = {
  *codex(run) {
    const r = yield sh(run, CODEX_FIND, [Math.floor((run.created_ms - 120000) / 1000), run.cwd ?? ""]);
    return pick(run, "codex", candidates(r.stdout, (c, l) => {
      if (c.first) {
        // The session's first line: its id is in the file's name, its folder among the first fields.
        c.id = c.path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(_\d+)?\.jsonl/i)?.[1] ?? null;
        const cwd = l.match(/"cwd":"((?:\\.|[^"\\])*)"/);
        c.cwd = cwd ? jsonString(cwd[1]) : null;
      }
      const t = Date.parse(l.match(/^\{"timestamp":"([^"]+)"/)?.[1] ?? "");
      if (t) c.starts.push(t);
    }));
  },
  *kimi(run) {
    const r = yield sh(run, KIMI_FIND, [Math.floor((run.created_ms - 120000) / 1000), run.cwd ?? ""]);
    return pick(run, "kimi", candidates(r.stdout, (c, l) => {
      if (c.first) {
        c.id = c.path.split("/").pop();
        if (!KIMI_ID.test(c.id)) c.id = null;
        let state = null;
        try { state = JSON.parse(l); } catch (_) {}
        const cwd = state?.cwd ?? l.match(/"cwd":"((?:\\.|[^"\\])*)"/)?.[1];
        c.cwd = cwd == null ? null : state ? cwd : jsonString(cwd);
      } else c.starts.push(...l.trim().split(/\s+/).map(Number).filter(Boolean));
    }));
  },
};

// What a log script printed: the lines, and where it read to: { file, offset, text }.
function lines(out, had) {
  const nl = out.indexOf("\n");
  const [o, file, size] = (nl < 0 ? out : out.slice(0, nl)).split("\t");
  const marked = o === "O";
  let text = !marked ? out : nl < 0 ? "" : out.slice(nl + 1);
  // Cut off at the limit, its last line is a half: whole lines only.
  const cut = text.length >= LIMIT || (text !== "" && !text.endsWith("\n"));
  if (cut) text = text.slice(0, text.lastIndexOf("\n") + 1);
  return { file: (marked && file) || null, offset: marked ? Number(size) || 0 : 0, text: (had?.text ?? "") + text, cut: Boolean(had?.cut) || cut };
}

// The rounds a run's session log has from while the run was alive. `had`: what an
// earlier look at a run still going returned; the log is read on from there.
const READ = {
  *codex(run, id, cwd, had = null) {
    const [from, to] = alive(run);
    const r = yield sh(run, CODEX_LOG, [id, new Date(from).toISOString(), new Date(to).toISOString(), LIMIT, had?.file ?? "-", had?.offset ?? 0]);
    const got = lines(r.stdout, had);
    // A log shorter than it was is another file under the old name: from its start.
    if (had && got.offset < had.offset) return yield* READ.codex(run, id, cwd);
    return { ...readRollout(got.text, { cwd }), ...got };
  },
  *kimi(run, id, cwd, had = null) {
    const [from, to] = alive(run);
    const r = yield sh(run, KIMI_LOG, [id, from, to, LIMIT, had?.file ?? "-", had?.offset ?? 0]);
    const got = lines(r.stdout, had);
    if (had && got.offset < had.offset) return yield* READ.kimi(run, id, cwd);
    return { ...readWire(got.text, { cwd }), ...got };
  },
};

function* terminalText(run) {
  try {
    const r = yield ["hc", ["read", run.address, "--lines", "1000", "--json"]];
    if (r.code !== 0) return { text: null, cut: false };
    const read = JSON.parse(r.stdout);
    return { text: (read.text ?? "").replace(/\s+$/, ""), cut: read.complete === false };
  } catch (_) {
    return { text: null, cut: false };
  }
}

function* labelFile(run, key) {
  const path = label(run, key);
  if (!path) return null;
  try {
    const text = yield ["file", path, machineOf(run.address)];
    return text?.trim() || null;
  } catch (_) {
    return null;
  }
}

const NOTHING = { steps: null, work: [], tokens: null, cached: null, ended: null };
const why = (e) => String(e?.message ?? e).split("\n")[0];

/** One finished run's rounds: from its agent's log when there is one, else one round
 * from its labels, command line and output, with a note saying what's missing. */
export function* roundsSteps(k) {
  const run = yield* recordSteps(k);
  const agent = agentOf(run);
  const where = machineOf(run.address) ? ` on ${machineOf(run.address)}` : "";
  const term = yield* terminalText(run);
  const asked = yield* labelFile(run, "herdr.request");
  const answered = yield* labelFile(run, "herdr.answer");
  let session = label(run, "herdr.session") ?? sessionFromArgv(run.argv, agent);
  let logged = [];
  let note = null;
  // The folder its paths are shown within: the session's own, when it was looked up.
  let folder = run.cwd;
  if (agent && run.created_ms != null) {
    try {
      if (session && !ID[agent].test(session)) session = null;
      if (!session && agent === "codex") session = term.text?.match(CODEX_SESSION)?.[1] ?? null;
      const named = session;
      let log = session ? yield* READ[agent](run, session, folder) : null;
      // No session named, or the one named has nothing from this run (an id that was
      // something else's): the one in the run's folder with a turn from while it ran.
      if (!log?.rounds.length) {
        const found = yield* FIND[agent](run);
        if (found.id && found.id !== named) {
          session = found.id;
          folder = found.cwd ?? folder;
          log = yield* READ[agent](run, session, folder);
        } else if (!named) note = found.note;
      }
      logged = log?.rounds ?? [];
      if (session && !logged.length) note = `${NAME[agent]}'s log of session ${session.replace(/^session_/, "").slice(0, 8)}${where} has no request from while this ran.`;
      else if (log?.cut) note = TOO_LONG;
    } catch (e) {
      note = `${NAME[agent]}'s own log of this run couldn't be read${where}: ${why(e)}`;
    }
  }
  const base = { run, transcript: term.text, cut: term.cut, session, live: false, note: null };
  if (!logged.length) {
    return [{ ...base, ...NOTHING, note, at: run.created_ms ?? null, end: run.finished_ms ?? null,
      request: asked ?? requestFromArgv(run.argv, agent), answer: answered }];
  }
  return logged.map((r, i) => {
    const last = i === logged.length - 1;
    return { ...base, ...r, note: last ? note : null, end: last ? run.finished_ms ?? r.end : r.end,
      request: i === 0 && asked ? asked : r.request, answer: last && answered ? answered : r.answer };
  });
}

// A log that isn't there in a run's first moments is only not there yet.
const SETTLING = 20000;

/** A run still going: { rounds, state }. Its rounds so far, from its agent's log, the
 * last one unfinished (no answer yet: what it says along the way is among its steps);
 * `state` is where this look ended, to hand back for the next one. Until the log has a
 * request of this run it is looked for each time; from then on it is read on. */
export function* liveSteps(k, had = null) {
  // Its record changes while it runs (a session label, set once the session is known).
  let run = had?.id ? had.run : yield* recordSteps({ ...k, argv: null });
  if (!Array.isArray(run.argv)) run = k;
  const agent = agentOf(run);
  const where = machineOf(run.address) ? ` on ${machineOf(run.address)}` : "";
  const asked = had ? had.asked : yield* labelFile(run, "herdr.request");
  let id = had?.id ?? null;
  let folder = had?.folder ?? run.cwd;
  let log = null;
  let note = null;
  if (agent && run.created_ms != null) {
    try {
      if (id) log = yield* READ[agent](run, id, folder, had.file ? had : null);
      else {
        let named = label(run, "herdr.session") ?? sessionFromArgv(run.argv, agent);
        if (named && !ID[agent].test(named)) named = null;
        if (named) log = yield* READ[agent](run, named, folder);
        if (log?.rounds.length) id = named;
        else {
          const found = yield* FIND[agent](run);
          if (found.id && found.id !== named) {
            folder = found.cwd ?? folder;
            log = yield* READ[agent](run, found.id, folder);
            if (log.rounds.length) id = found.id;
          }
          if (!id) {
            log = null;
            if (Date.now() - run.created_ms > SETTLING) note = named ? `${NAME[agent]}'s log of session ${named.replace(/^session_/, "").slice(0, 8)}${where} has no request of this run yet.` : found.note;
          }
        }
      }
    } catch (e) {
      // A look that failed keeps what the last one showed, and says so.
      log = had?.id ? { rounds: had.rounds ?? [], file: had.file, offset: had.offset, text: had.text, cut: had.cut } : null;
      note = `${NAME[agent]}'s own log of this run couldn't be read${where}: ${why(e)}`;
    }
  }
  const logged = log?.rounds ?? [];
  const state = { run, asked, id, folder, rounds: logged, file: log?.file ?? null, offset: log?.offset ?? 0, text: log?.text ?? "", cut: log?.cut ?? false };
  const base = { run, transcript: null, cut: false, session: id ?? label(run, "herdr.session"), live: true, note: null };
  if (!logged.length) {
    return { state, rounds: [{ ...base, ...NOTHING, done: false, note, at: run.created_ms ?? null, end: null,
      request: asked ?? requestFromArgv(run.argv, agent), answer: null }] };
  }
  return { state, rounds: logged.map((r, i) => {
    const last = i === logged.length - 1;
    if (!last || r.done) return { ...base, ...r, note: last ? note : null, request: i === 0 && asked ? asked : r.request };
    // Its turn isn't over: what it said last is not its answer yet. `seen`: when its
    // log was last written to.
    const work = r.answer ? [...r.work, step(r.end, "say", r.answer)] : r.work;
    return { ...base, ...r, work, answer: null, end: null, seen: r.end, note: note ?? (log.cut ? TOO_LONG : null), request: i === 0 && asked ? asked : r.request };
  }) };
}

/** What a run still going was asked: its request label's file, else its command line,
 * else what its agent's log has (a prompt on stdin or through a wrapper is only there). */
export function* requestSteps(k) {
  let run = yield* recordSteps({ ...k, argv: null });
  if (!Array.isArray(run.argv)) run = k;
  const asked = (yield* labelFile(run, "herdr.request")) ?? requestFromArgv(run.argv, agentOf(run));
  if (asked) return asked;
  const { rounds } = yield* liveSteps(run);
  return rounds[rounds.length - 1]?.request ?? null;
}

// One run that can't be read costs its own round's details, never the others'.
const unread = (run, e) => [{ ...NOTHING, run, at: run.created_ms ?? null, end: run.finished_ms ?? null, request: null, answer: null,
  transcript: null, cut: false, session: null, live: false, note: `This run couldn't be read: ${why(e)}` }];

/** Rounds of several runs as one conversation, oldest first. */
export const inOrder = (lists) => lists.flat().sort(byTime);

/** A finished run's rounds: { at, end, run, request, answer, steps, work, tokens, cached, ended, done, transcript, cut, session, note, live }. */
export const finishedRounds = (run) => drive(roundsSteps(run)).catch((e) => unread(run, e));

/** A running one's: { rounds, state }; hand `state` back at the next look. */
export const liveRounds = (run, had = null) => drive(liveSteps(run, had))
  .catch((e) => ({ state: had, rounds: unread(run, e).map((r) => ({ ...r, live: true, end: null })) }));

/** What a running one was asked, or null while that isn't known. */
export const liveRequest = (run) => drive(requestSteps(run)).catch(() => null);
