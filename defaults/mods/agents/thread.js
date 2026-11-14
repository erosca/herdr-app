// A sub-agent's conversation: what its parent asked, what it did and what it answered,
// round by round, from the best source each run has:
//   1. labels its parent set: herdr.request=<file>, herdr.answer=<file>, herdr.session=<id>;
//   2. the agent's own session log, nothing cut: codex's
//      (~/.codex/sessions/**/rollout-<time>-<id>.jsonl[.zst]) or kimi's
//      (~/.kimi/sessions/<md5 of its folder>/<id>/wire.jsonl): every request, each step
//      (what it thought, ran, read and edited), the final answer, the tokens;
//   3. the terminal: its command line and the last 1000 lines herdr-core keeps.

import { hc, exec, home, readTextFile } from "herdr";

const CODEX_SESSION = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// Text codex adds to a user turn itself: environment, AGENTS.md, skills, notices.
const CONTEXT = /^\s*(<(?!stdin\b)[A-Za-z_][\w-]*[\s>]|# AGENTS\.md instructions)/;

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const label = (run, key) => run.labels?.[key] || null;
// A session id goes into a find pattern: only what an id can hold.
const SESSION_ID = /^[0-9A-Za-z-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = { codex: /(^|\/)codex$/, kimi: /(^|\/)kimi(-cli)?$/ };

/** "codex", "kimi", or null: whose session log a run left. */
export function agentOf(run) {
  const key = run.program?.key ?? "";
  if (key === "codex") return "codex";
  if (/^kimi/.test(key)) return "kimi";
  const argv = Array.isArray(run.argv) ? run.argv.slice(0, 4) : [];
  for (const [name, re] of Object.entries(AGENTS)) if (argv.some((a) => re.test(a))) return name;
  return null;
}

// A follow-up names its session: `codex exec resume <id>`, `kimi -r <id>` (or -S, --session).
function sessionFromArgv(argv, agent) {
  if (!Array.isArray(argv)) return null;
  if (agent === "codex") {
    const i = argv.indexOf("resume");
    return i > 0 ? argv.slice(i + 1).find((a) => UUID.test(a)) ?? null : null;
  }
  if (agent === "kimi") {
    const i = argv.findIndex((a) => /^(-r|-S|--resume|--session)$/.test(a));
    const id = i > 0 ? argv[i + 1] : argv.find((a) => /^--(resume|session)=/.test(a))?.split("=")[1];
    return id && SESSION_ID.test(id) ? id : null;
  }
  return null;
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
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
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

// `hc ls --json` lists a short form of each terminal, without its command line, labels
// or times: the whole record comes from `hc get`. A finished one doesn't change.
export async function fullRecord(k) {
  if (Array.isArray(k.argv) && k.created_ms != null) return k;
  try {
    const r = await hc(["get", k.address, "--json"]);
    if (r.code !== 0) return k;
    const full = JSON.parse(r.stdout);
    // The list's address and parent say which machine; keep them as the list has them.
    return { ...k, ...full, address: k.address, parent: k.parent ?? full.parent ?? null, program: k.program ?? null };
  } catch (_) {
    return k;
  }
}

// The prompt on the command line: kimi's -p/--prompt/-c/--command value, else the
// longest argument that reads like a sentence (codex's prompt). Null for a shell
// script (`sh -c ...`): its prompt can't be told from the rest.
export function requestFromArgv(argv, agent = null) {
  if (!Array.isArray(argv)) return null;
  if (argv.length > 1 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && argv[1] === "-c") return null;
  if ((agent ?? agentOf({ argv })) === "kimi") {
    const i = argv.findIndex((a) => /^(-p|--prompt|-c|--command)$/.test(a));
    if (i > 0 && argv[i + 1]) return argv[i + 1];
    const eq = argv.find((a) => /^--(prompt|command)=/.test(a));
    if (eq) return eq.slice(eq.indexOf("=") + 1);
  }
  const words = argv.slice(1).filter((a) => /\s/.test(a) && a.length >= 20);
  return words.sort((x, y) => y.length - x.length)[0] ?? null;
}

// Steps: { at, kind, text, detail?, error? }. kind: think (what it set out to do), say
// (what it told along the way), run, read, edit, search, fetch, plan, tool.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

function step(at, kind, full, detail = null) {
  const all = String(full ?? "").trim();
  const one = firstLine(all);
  const text = clip(one, 240) + (all.includes("\n") && one.length <= 240 ? " …" : "");
  const more = String(detail ?? all).trim();
  return { at, kind, text, detail: more && more !== text ? clip(more, 1500) : null };
}

/** A reasoning summary's headline: its bold title, else its first line. */
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
    if (c.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(c[0]) && /^-\w*c$/.test(c[1])) return c.slice(2).join(" ");
    return c.join(" ");
  }
  return null;
}

const patchPaths = (patch) => [...String(patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

// One codex tool call as a step's { kind, text }, or null for plumbing.
function codexStep(p) {
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

const byTime = (x, y) => (x.at ?? 0) - (y.at ?? 0);

/** codex's session log: requests start rounds; steps, answers and tokens fill them. */
export function readRollout(text) {
  const out = { id: null, rounds: [] };
  let round = null;
  let total = null; // codex's running token count for the session
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const p = r.payload ?? {};
    const at = Date.parse(r.timestamp) || null;
    if (r.type === "session_meta") {
      out.id = out.id ?? p.id ?? null;
      continue;
    }
    if (r.type === "event_msg") {
      const sum = p.type === "token_count" ? p.info?.total_token_usage?.total_tokens : null;
      if (typeof sum === "number") {
        // A resumed session may count afresh.
        if (round && sum < round.tokens0) round.tokens0 = 0;
        if (round) round.tokens = sum - round.tokens0;
        total = sum;
      }
      continue;
    }
    if (r.type !== "response_item") continue;
    if (p.type === "message" && p.role === "user") {
      const asked = (p.content ?? [])
        .filter((c) => c.type === "input_text" && c.text && !CONTEXT.test(c.text))
        .map((c) => c.text.trim())
        .filter(Boolean)
        .join("\n\n");
      // A resumed session's files can repeat earlier turns.
      if (!asked || seen.has(`${at}\u0000${asked}`)) continue;
      seen.add(`${at}\u0000${asked}`);
      round = { at, request: asked, answer: null, final: false, steps: 0, work: [], tokens: null, tokens0: total ?? 0, end: at };
      out.rounds.push(round);
      continue;
    }
    if (!round) continue;
    if (at != null) round.end = at;
    if (p.type === "message" && p.role === "assistant") {
      const said = (p.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("").trim();
      if (!said) continue;
      if (p.phase === "commentary") round.work.push(step(at, "say", said));
      else if (p.phase === "final_answer") {
        round.answer = said;
        round.final = true;
      } else if (!round.final) {
        // No phases (older models): every message but the last was said along the way.
        if (round.answer) round.work.push(step(round.answerAt, "say", round.answer));
        round.answer = said;
        round.answerAt = at;
      }
    } else if (p.type === "reasoning") {
      for (const s of p.summary ?? []) if (s?.text?.trim()) round.work.push(step(at, "think", headline(s.text), s.text));
    } else if (/_call$/.test(p.type ?? "")) {
      const s = codexStep(p);
      if (s) {
        round.work.push(step(at, s.kind, s.text));
        round.steps += 1;
      }
    }
  }
  for (const r of out.rounds) {
    r.work.sort(byTime);
    delete r.tokens0;
    delete r.answerAt;
  }
  return out;
}

const inputText = (u) => (typeof u === "string" ? u : Array.isArray(u) ? u.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "");

// One kimi tool call as a step's { kind, text, detail? }.
function kimiStep(name, raw) {
  const a = parseArgs(raw);
  switch (name) {
    case "Shell": return { kind: "run", text: a.command ?? "a command" };
    case "ReadFile": case "ReadMediaFile": return { kind: "read", text: a.path ?? name };
    case "WriteFile": case "StrReplaceFile": return { kind: "edit", text: a.path ?? name };
    case "Grep": return { kind: "search", text: [a.pattern, a.path].filter(Boolean).join(" in ") || name };
    case "Glob": return { kind: "search", text: a.pattern ?? name };
    case "SearchWeb": return { kind: "search", text: a.query ?? "the web" };
    case "FetchURL": return { kind: "fetch", text: a.url ?? name };
    case "Think": return { kind: "think", text: headline(a.thought), detail: a.thought };
    case "SetTodoList": return { kind: "plan", text: "Updated its to-do list" };
    default: return name ? { kind: "tool", text: name } : null;
  }
}

/** kimi's wire.jsonl: after a metadata line, { timestamp: seconds, message: { type, payload } } a line. */
export function readWire(text) {
  const out = { rounds: [] };
  let round = null;
  let said = ""; // the text of the step in progress: the answer, if it's the last
  let saidAt = null;
  const calls = new Map();
  const keepSaid = () => {
    if (round && said.trim()) round.work.push(step(saidAt, "say", said));
    said = "";
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    const m = r.message;
    if (!m?.type) continue;
    const p = m.payload ?? {};
    const at = typeof r.timestamp === "number" ? Math.round(r.timestamp * 1000) : null;
    if (m.type === "TurnBegin" || m.type === "SteerInput") {
      if (round && !round.ended) keepSaid();
      said = "";
      round = { at, request: inputText(p.user_input).trim() || null, answer: null, steps: 0, work: [], tokens: 0, end: at };
      out.rounds.push(round);
      continue;
    }
    if (!round || round.ended) continue;
    if (at != null) round.end = at;
    if (m.type === "StepBegin") keepSaid();
    else if (m.type === "ContentPart") {
      if (p.type === "text" && p.text) {
        if (!said) saidAt = at;
        said += p.text;
      } else if (p.type === "think" && p.think?.trim()) round.work.push(step(at, "think", headline(p.think), p.think));
    } else if (m.type === "ToolCall") {
      const s = kimiStep(p.function?.name, p.function?.arguments);
      if (!s) continue;
      const st = step(at, s.kind, s.text, s.detail);
      round.work.push(st);
      if (p.id) calls.set(p.id, st);
      if (s.kind !== "think") round.steps += 1;
    } else if (m.type === "ToolResult") {
      const st = calls.get(p.tool_call_id);
      if (st && (p.is_error ?? p.return_value?.is_error)) st.error = true;
    } else if (m.type === "StatusUpdate" && p.token_usage) {
      const u = p.token_usage;
      round.tokens += (u.input_other ?? 0) + (u.output ?? 0) + (u.input_cache_read ?? 0) + (u.input_cache_creation ?? 0);
    } else if (m.type === "TurnEnd") {
      // The last step's text is the answer.
      round.answer = said.trim() || null;
      said = "";
      round.ended = true;
    }
  }
  if (round && !round.ended) keepSaid();
  for (const r of out.rounds) {
    r.work.sort(byTime);
    if (!r.tokens) r.tokens = null;
    delete r.ended;
  }
  return out;
}

// The files of a codex session (a resumed one may span several, older ones compressed).
// Tool outputs, codex's instructions and encrypted reasoning are most of a log's size
// and nothing we show.
const CODEX_LOG = String.raw`id=$1; shift; for f in $(find "$@" -name "rollout-*$id*.jsonl*" 2>/dev/null | sort); do case "$f" in *.zst) zstd -dcq "$f" 2>/dev/null;; *) cat "$f";; esac; done | grep -v -e '_call_output"' -e '"type":"turn_context"' -e '"role":"developer"' | sed -E 's/"encrypted_content":"[^"]*"/"encrypted_content":null/g'`;

async function codexLog(id) {
  if (!UUID.test(id)) return null;
  const r = await exec("sh", ["-c", CODEX_LOG, "sh", id, `${home()}/.codex/sessions`, `${home()}/.codex/archived_sessions`]);
  return r.stdout ? readRollout(r.stdout) : null;
}

// A first round with no id at hand: the session that started in the run's folder
// within a minute and a half of the run.
async function codexMatch(run) {
  if (run.created_ms == null || !run.cwd) return null;
  const since = Math.floor((run.created_ms - 120000) / 1000);
  const script = 'find "$1" -name "rollout-*.jsonl*" -newermt "@$2" 2>/dev/null | while read -r f; do '
    + 'case "$f" in *.zst) zstd -dcq "$f" 2>/dev/null | head -n 1;; *) head -n 1 "$f";; esac; done';
  const r = await exec("sh", ["-c", script, "sh", `${home()}/.codex/sessions`, String(since)]);
  let best = null;
  for (const line of r.stdout.split("\n")) {
    try {
      const m = JSON.parse(line);
      const p = m.payload ?? {};
      if (m.type !== "session_meta" || p.cwd !== run.cwd) continue;
      const off = Math.abs((Date.parse(p.timestamp) || 0) - run.created_ms);
      if (off < 90000 && (!best || off < best.off)) best = { id: p.id, off };
    } catch (_) {}
  }
  return best?.id ?? null;
}

// kimi keeps its sessions in $KIMI_SHARE_DIR/sessions, else ~/.kimi/sessions.
const KIMI_ROOT = String.raw`if [ -n "$KIMI_SHARE_DIR" ]; then root="$KIMI_SHARE_DIR/sessions"; else root="$2/.kimi/sessions"; fi; `;
// A tool's output is most of the file and nothing we show: only whether it failed is kept.
const KIMI_LOG = KIMI_ROOT + String.raw`f=$(find "$root" -mindepth 3 -maxdepth 3 -path "*/$1/wire.jsonl" 2>/dev/null | head -n 1); [ -n "$f" ] || exit 1; sed -E '/"type": "ToolResult", "payload"/s/^\{"timestamp": ([0-9.eE+-]+),.*"tool_call_id": "([^"]*)".*"is_error": (true|false).*$/{"timestamp": \1, "message": {"type": "ToolResult", "payload": {"tool_call_id": "\2", "is_error": \3}}}/' "$f"`;
// Sessions written to since the run began: each with the times its turns began.
// First line: the md5 of the run's folder, which names kimi's folder for it.
const KIMI_FIND = KIMI_ROOT + String.raw`printf '%s' "$3" | md5sum 2>/dev/null | cut -c1-32; find "$root" -mindepth 3 -maxdepth 3 -name wire.jsonl -newermt "@$4" 2>/dev/null | while read -r f; do printf '%s\t%s\n' "$f" "$(grep '"type": "TurnBegin"' "$f" | sed -E 's/^\{"timestamp": ([0-9.eE+-]+),.*/\1/' | tr '\n' ' ')"; done`;

async function kimiLog(id) {
  if (!SESSION_ID.test(id)) return null;
  const r = await exec("sh", ["-c", KIMI_LOG, "sh", id, home()]);
  return r.code === 0 && r.stdout ? readWire(r.stdout) : null;
}

// The kimi session one of whose turns began within two minutes of the run, preferring
// the run's own folder.
async function kimiMatch(run) {
  if (run.created_ms == null) return null;
  const since = Math.floor((run.created_ms - 120000) / 1000);
  const r = await exec("sh", ["-c", KIMI_FIND, "sh", "", home(), run.cwd ?? "", String(since)]);
  const [hash, ...lines] = r.stdout.split("\n");
  let best = null;
  for (const l of lines) {
    const [path, times] = l.split("\t");
    const parts = (path ?? "").split("/");
    const id = parts.at(-2);
    if (!id || !SESSION_ID.test(id)) continue;
    for (const ts of (times ?? "").trim().split(/\s+/)) {
      const off = Math.abs(parseFloat(ts) * 1000 - run.created_ms);
      if (!(off < 120000)) continue;
      const score = off + (hash.trim() && parts.at(-3) === hash.trim() ? 0 : 120000);
      if (!best || score < best.score) best = { id, score };
    }
  }
  return best?.id ?? null;
}

const readLog = (agent, id) => (agent === "kimi" ? kimiLog(id) : codexLog(id));

async function terminalText(run) {
  try {
    const r = await hc(["read", run.address, "--lines", "1000", "--json"]);
    if (r.code !== 0) return { text: null, cut: false };
    const read = JSON.parse(r.stdout);
    return { text: (read.text ?? "").replace(/\s+$/, ""), cut: read.complete === false };
  } catch (_) {
    return { text: null, cut: false };
  }
}

async function labelFile(run, key) {
  const path = label(run, key);
  if (!path) return null;
  try {
    const text = await readTextFile(path, { on: machineOf(run.address) });
    return text?.trim() || null;
  } catch (_) {
    return null;
  }
}

/** Rounds oldest first: { at, end, run, request, answer, steps, work, tokens, transcript, cut, session, live }. */
export async function loadConversation(runs, live = []) {
  runs = await Promise.all(runs.map(fullRecord));
  live = await Promise.all(live.map(fullRecord));
  const rounds = [];
  const logs = new Map(); // agent + session id -> its rounds from the log
  const facts = [];
  // One run that can't be read costs its own round's details, never the others'.
  for (const run of runs) {
    const agent = agentOf(run);
    let term = { text: null, cut: false };
    let session = label(run, "herdr.session") ?? sessionFromArgv(run.argv, agent);
    try {
      term = await terminalText(run);
      if (!session && agent === "codex") session = term.text?.match(CODEX_SESSION)?.[1] ?? (await codexMatch(run));
      if (!session && agent === "kimi") session = await kimiMatch(run);
      const key = `${agent}\u0000${session}`;
      if (agent && session && !logs.has(key)) logs.set(key, (await readLog(agent, session).catch(() => null))?.rounds ?? []);
    } catch (_) {}
    facts.push({ run, term, session, agent, key: `${agent}\u0000${session}` });
  }
  const used = new Set();
  const fromLog = (r) => ({ request: r.request, answer: r.answer, steps: r.steps, work: r.work ?? [], tokens: r.tokens ?? null });
  for (const { run, term, session, agent, key } of facts) {
    const base = { run, transcript: term.text, cut: term.cut, session, live: false };
    try {
      const from = (run.created_ms ?? 0) - 5000;
      const to = (run.finished_ms ?? Date.now()) + 5000;
      const logged = run.created_ms == null ? [] : (logs.get(key) ?? []).filter((r) => r.at != null && r.at >= from && r.at <= to);
      const asked = await labelFile(run, "herdr.request");
      const answered = await labelFile(run, "herdr.answer");
      if (logged.length) {
        logged.forEach((r, i) => {
          used.add(r);
          const last = i === logged.length - 1;
          rounds.push({ ...base, ...fromLog(r), at: r.at, end: last ? run.finished_ms ?? r.end : r.end,
            request: i === 0 && asked ? asked : r.request, answer: last && answered ? answered : r.answer });
        });
      } else {
        rounds.push({ ...base, at: run.created_ms ?? null, end: run.finished_ms ?? null, request: asked ?? requestFromArgv(run.argv, agent),
          answer: answered, steps: null, work: [], tokens: null });
      }
    } catch (_) {
      rounds.push({ ...base, at: run.created_ms ?? null, end: run.finished_ms ?? null, request: null, answer: null, steps: null, work: [], tokens: null });
    }
  }
  // Rounds of these sessions that ran outside Herdr, or in terminals the core forgot.
  for (const [key, list] of logs) {
    for (const r of list) {
      if (!used.has(r)) rounds.push({ ...fromLog(r), at: r.at, end: r.end, run: null, transcript: null, cut: false, session: key.split("\u0000")[1], live: false });
    }
  }
  for (const run of live) {
    rounds.push({ at: run.created_ms ?? null, end: null, run, request: (await labelFile(run, "herdr.request")) ?? requestFromArgv(run.argv, agentOf(run)),
      answer: null, steps: null, work: [], tokens: null, transcript: null, cut: false, session: label(run, "herdr.session"), live: true });
  }
  return rounds.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
}
