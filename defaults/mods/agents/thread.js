// A sub-agent's conversation: what its parent asked and what it answered, round by
// round, from the best source each run has:
//   1. labels its parent set: herdr.request=<file>, herdr.answer=<file>, herdr.session=<id>;
//   2. codex's own session log (~/.codex/sessions/**/rollout-<time>-<id>.jsonl[.zst]):
//      every request, the final answer and the tool calls, nothing cut;
//   3. the terminal: its command line and the last 1000 lines herdr-core keeps.

import { hc, exec, home, readTextFile } from "herdr";

const CODEX_SESSION = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// Text codex adds to a user turn itself: environment, AGENTS.md, skills, notices.
const CONTEXT = /^\s*(<(?!stdin\b)[A-Za-z_][\w-]*[\s>]|# AGENTS\.md instructions)/;

const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : null);
const label = (run, key) => run.labels?.[key] || null;
// A session id goes into a find pattern: only what an id can hold.
const SESSION_ID = /^[0-9A-Za-z-]{8,64}$/;
const isCodex = (run) => run.program?.key === "codex" || (run.argv ?? []).some((a) => /(^|\/)codex$/.test(a));

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

// The prompt on the command line: codex's last plain argument, else the longest
// argument that reads like a sentence. Null for a shell script (`sh -c ...`).
export function requestFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.length > 1 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]) && argv[1] === "-c") return null;
  const words = argv.slice(1).filter((a) => /\s/.test(a) && a.length >= 20);
  return words.sort((x, y) => y.length - x.length)[0] ?? null;
}

// One rollout line's JSON: requests start rounds; answers and tool calls fill them.
export function readRollout(text) {
  const out = { id: null, rounds: [] };
  let round = null;
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
      round = { at, request: asked, answer: null, final: false, steps: 0, end: at };
      out.rounds.push(round);
    } else if (round && p.type === "message" && p.role === "assistant") {
      const said = (p.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("").trim();
      // The final answer, else the last thing it said (models without phases).
      if (said && (p.phase === "final_answer" || !round.final)) {
        round.answer = said;
        round.final = p.phase === "final_answer";
      }
      round.end = at ?? round.end;
    } else if (round && /_call$/.test(p.type ?? "")) {
      round.steps += 1;
      round.end = at ?? round.end;
    }
  }
  return out;
}

// The files of a codex session (a resumed one may span several, older ones compressed).
async function codexLog(id) {
  const roots = [`${home()}/.codex/sessions`, `${home()}/.codex/archived_sessions`];
  // Tool outputs and reasoning are most of a log's size and nothing we show.
  if (!SESSION_ID.test(id)) return null;
  const script = 'id=$1; shift; for f in $(find "$@" -name "rollout-*$id*.jsonl*" 2>/dev/null | sort); do '
    + 'case "$f" in *.zst) zstd -dcq "$f" 2>/dev/null;; *) cat "$f";; esac; done '
    + '| grep -v -e "_call_output\\"" -e "\\"type\\":\\"reasoning\\""';
  const r = await exec("sh", ["-c", script, "sh", id, ...roots]);
  return r.code === 0 || r.stdout ? readRollout(r.stdout) : null;
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

/** Rounds oldest first: { at, end, run, request, answer, steps, transcript, cut, session, live }. */
export async function loadConversation(runs, live = []) {
  runs = await Promise.all(runs.map(fullRecord));
  live = await Promise.all(live.map(fullRecord));
  const rounds = [];
  const sessions = new Map(); // session id -> its rounds from the log
  const facts = [];
  // One run that can't be read costs its own round's details, never the others'.
  for (const run of runs) {
    let term = { text: null, cut: false };
    let session = label(run, "herdr.session");
    try {
      term = await terminalText(run);
      if (!session && isCodex(run)) session = term.text?.match(CODEX_SESSION)?.[1] ?? (await codexMatch(run));
      if (session && !sessions.has(session)) sessions.set(session, (await codexLog(session).catch(() => null))?.rounds ?? []);
    } catch (_) {}
    facts.push({ run, term, session });
  }
  const used = new Set();
  for (const { run, term, session } of facts) {
    const base = { run, transcript: term.text, cut: term.cut, session, live: false };
    try {
      const from = (run.created_ms ?? 0) - 5000;
      const to = (run.finished_ms ?? Date.now()) + 5000;
      const logged = run.created_ms == null ? [] : (sessions.get(session) ?? []).filter((r) => r.at != null && r.at >= from && r.at <= to);
      const asked = await labelFile(run, "herdr.request");
      const answered = await labelFile(run, "herdr.answer");
      if (logged.length) {
        logged.forEach((r, i) => {
          used.add(r);
          const last = i === logged.length - 1;
          rounds.push({ ...base, at: r.at, end: last ? run.finished_ms ?? r.end : r.end,
            request: i === 0 && asked ? asked : r.request, answer: last && answered ? answered : r.answer, steps: r.steps });
        });
      } else {
        rounds.push({ ...base, at: run.created_ms ?? null, end: run.finished_ms ?? null, request: asked ?? requestFromArgv(run.argv),
          answer: answered, steps: null });
      }
    } catch (_) {
      rounds.push({ ...base, at: run.created_ms ?? null, end: run.finished_ms ?? null, request: null, answer: null, steps: null });
    }
  }
  // Rounds of these sessions that ran outside Herdr, or in terminals the core forgot.
  for (const [session, list] of sessions) {
    for (const r of list) {
      if (!used.has(r)) rounds.push({ at: r.at, end: r.end, run: null, request: r.request, answer: r.answer, steps: r.steps,
        transcript: null, cut: false, session, live: false });
    }
  }
  for (const run of live) {
    rounds.push({ at: run.created_ms ?? null, end: null, run, request: (await labelFile(run, "herdr.request")) ?? requestFromArgv(run.argv),
      answer: null, steps: null, transcript: null, cut: false, session: label(run, "herdr.session"), live: true });
  }
  return rounds.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
}
