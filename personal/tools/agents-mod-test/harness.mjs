import fs from "fs";
const [src, dir] = process.argv.slice(2);
const allowed = new Set([...fs.readFileSync(`${dir}/allowed.txt`, "utf8").split("\n"), ...fs.readFileSync(`${dir}/shipped.txt`, "utf8").split("\n")]);
const used = new Set();
function el(type, arg) {
  const node = { __type: type, __arg: arg, __id: null, __kids: [], __calls: [], __h: {} };
  const p = new Proxy(node, { get(t, m) {
    if (typeof m === "symbol" || String(m).startsWith("__")) return t[m];
    return (...a) => {
      used.add(m); t.__calls.push(m);
      if (m === "id") t.__id = a[0];
      if (m === "child") { if (a[0] != null) t.__kids.push(a[0]); }
      if (m === "children") t.__kids.push(...a[0].filter((x) => x != null));
      if (m === "when") { if (a[0]) return a[1](p); }
      if (m === "hover") a[0](el("style"));
      if (["on_click", "on_hover", "tooltip", "on_key_down", "on_size_change"].includes(m)) t.__h[m] = a[0];
      if (m === "h") (t.__heights ??= []).push(a[0]);
      return p;
    };
  }});
  return p;
}
const shared = {}; const store = {}; const closed = []; let overlays = []; const runs = [];
const SHORT = ["address", "name", "template", "parent", "state", "turn", "exit_code", "signal", "reason", "cwd"];
const short = (k) => Object.fromEntries(SHORT.filter((f) => k[f] != null).map((f) => [f, k[f]]));
const CORE = {}; const gets = []; let HOME_DIR = "/home/u";
// Overlay props cross into the new copy as plain data: undefined arrives as null.
const bridge = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (v === undefined ? null : v)));
let P = {}; let HC = { get: async (a) => { gets.push(a[1]); return CORE[a[1]] ? { code: 0, stdout: JSON.stringify(CORE[a[1]]), stderr: "" } : { code: 1, stdout: "", stderr: "no such terminal" }; } }; let EXEC = async () => ({ code: 0, stdout: "", stderr: "" }); const FILES = {}; const editorOpts = [];
const EDITOR_KEYS = ["language","value","line_numbers","folding","readonly","soft_wrap","syntax","font_family","font_size"];
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
globalThis.__g = {
  View: class {}, div: () => el("div"), image: (s) => el("image", s), svg: (s) => el("svg", s),
  v_flex: () => el("v"), h_flex: () => el("h"),
  Editor: { new: (s) => el("editor", s) },
  TextView: { markdown: (id, md) => { const e = el("markdown", md); e.__md = md; return e; } },
  exec: async (cmd, args) => EXEC(cmd, args), home: () => HOME_DIR, readTextFile: async (path) => { if (!(path in FILES)) throw new Error("no file"); return FILES[path]; },
  EditorState: { new: (o) => { for (const k of Object.keys(o)) if (!EDITOR_KEYS.includes(k)) throw new Error("editor option " + k); editorOpts.push(o); return { o }; } },
  agents: () => globalThis.__agents, terminals: () => globalThis.__terms, panes: () => [], focused: () => null,
  spaces: () => [{ id: "sp1", tabs: [{ id: "tb1", name: "1" }] }], run: (n, a) => runs.push([n, a]), theme: () => new Proxy({}, { get: (_, k) => "#" + String(k) }),
  shared: (k) => shared[k], setShared: (k, v) => { shared[k] = v; }, setAgentOrder: () => null,
  openOverlay: (o) => { overlays.push(bridge(o)); return "ov1"; }, closeOverlay: (id) => closed.push(id), props: () => P,
  window: () => ({ platform: "linux" }), layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: 250 } }] }),
  // Like the real hc: `ls --json` prints each terminal's short form; `get` the whole record.
  hc: async (args) => {
    const r = await HC[args[0]](args);
    if (args[0] !== "ls") return r;
    const j = JSON.parse(r.stdout);
    for (const k of j.terminals ?? []) CORE[k.address] = k;
    j.terminals = (j.terminals ?? []).map(short);
    return { ...r, stdout: JSON.stringify(j) };
  }, settings: () => ({ font_family: "DejaVu Sans Mono" }),
};
const out = `${dir}/mod_${Date.now()}`; fs.mkdirSync(out);
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".js"))) {
  const code = fs.readFileSync(`${src}/${f}`, "utf8").replace(/^import \{([^}]*)\} from "(gpui-kit|gpui-base|herdr)";$/gm, "const {$1} = globalThis.__g;");
  fs.writeFileSync(`${out}/${f.replace(/\.js$/, ".mjs")}`, code.replace(/from "\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"'));
}
const lib = await import(`${out}/main.mjs`); globalThis.__Mod = lib.default;
const thread = await import(`${out}/thread.mjs`);
const Mod = globalThis.__Mod;
const timers = []; let notes = 0; const tasks = [];
const cx = { focus_handle: () => ({ focus: () => null }), timer: { every: (ms, f) => timers.push(f) }, spawn: (f) => tasks.push(f(cx)), notify: () => notes++, stop_propagation: () => {} };
const settle = async () => { while (tasks.length) await tasks.shift(); };
const ids = (n, out = []) => { if (!n || typeof n !== "object") return out; if (n.__id) out.push(n.__id); for (const k of n.__kids ?? []) ids(k, out); return out; };
const find = (n, id) => { if (!n || typeof n !== "object") return null; if (n.__id === id) return n; for (const k of n.__kids ?? []) { const f = find(k, id); if (f) return f; } return null; };
const text = (n, out = []) => { if (typeof n === "string") out.push(n); else if (n && n.__kids) n.__kids.forEach((k) => text(k, out)); return out; };
const rowsOf = (tree) => ids(tree).filter((i) => /^(ag-t|sub-|done-|fin-)/.test(i));

// The world: Claude (t1) with three live reviewers and four that finished (one is a grandchild).
const prog = (key, name) => ({ key, name, icon: `icons/${key}.svg`, tint: true });
globalThis.__agents = [{ address: "t1", status: "working", program: prog("claude", "Claude"), space: "sp1", space_name: "proj", tab: "tb1", pane: "p1", seq: 1, focused: false }];
globalThis.__terms = [
  { address: "t1", state: "live", program: prog("claude", "Claude"), status: "working" },
  { address: "t2", state: "live", parent: "t1", name: "review-codex", program: prog("codex", "Codex"), status: "working", status_ms: 100, created_ms: 50 },
  { address: "t3", state: "live", parent: "t1", name: "review-kimi", program: prog("kimi", "Kimi"), status: "idle", status_ms: 300, created_ms: 60 },
  { address: "t4", state: "live", parent: "t1", name: "lint", program: prog("sh", "Shell"), status: "idle", status_ms: 200, created_ms: 70 },
];
const finished = [
  { address: "t5", state: "finished", parent: "t1", name: "w-old", exit_code: 0, reason: "exited", created_ms: 0, finished_ms: 1000 },
  { address: "t6", state: "finished", parent: "t1", name: "w-failed", exit_code: 1, reason: "exited", created_ms: 0, finished_ms: 2000 },
  { address: "t7", state: "finished", parent: "t1", name: "w-stopped", exit_code: null, signal: 15, reason: "killed", created_ms: 500, finished_ms: 1500 },
  { address: "t8", state: "finished", parent: "t2", name: "grandchild", exit_code: 0, reason: "exited", created_ms: 900, finished_ms: 1800 },
  { address: "t9", state: "finished", parent: "t99", name: "someone-else", exit_code: 0, reason: "exited", finished_ms: 1900 },
];
HC.ls = async () => ({ code: 0, stdout: JSON.stringify({ terminals: [...globalThis.__terms, ...finished], hidden_finished: 0, machines: [] }), stderr: "" });
HC.read = async (a) => ({ code: 0, stdout: JSON.stringify({ text: `hello from ${a[1]}\nline 2\n\n\n`, complete: true, how: "history" }), stderr: "" });

const m = new Mod(); m.init({}, cx);
let tree = m.render(cx);                       // first render stamps the live ones
for (const f of timers) f(cx); await settle();   // the 2 s timer asks the core
tree = m.render(cx);
const check = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };
let rows = rowsOf(tree);
console.log("rows:", rows.join(" "));
check(JSON.stringify(rows) === JSON.stringify(["ag-t1", "sub-t2", "sub-t3", "sub-t4", "done-t1"]), "live sub-agents: working first, then newest end of work; one folded finished row last");
check(text(find(tree, "done-t1")).join("|").includes("4 finished") && text(find(tree, "done-t1")).join("|").includes("1 failed"), "folded row says 4 finished, 1 failed (t9 belongs to another agent)");
const lineOf = (id) => find(tree, id).__kids.filter((k) => k.__type === "div" && k.__calls.includes("self_start")).map((k) => (k.__calls.includes("border_b") ? "corner" : k.__calls.includes("border_l") ? "bar" : "space"));
check(JSON.stringify(lineOf("sub-t4")) === '["corner"]' && JSON.stringify(lineOf("done-t1")) === '["corner"]', "the last live row's line runs on to the finished row");
find(tree, "done-t1").__h.on_click(null, cx); tree = m.render(cx); rows = rowsOf(tree);
console.log("open:", rows.join(" "));
check(JSON.stringify(rows.slice(5)) === JSON.stringify(["fin-t6", "fin-t8", "fin-t7", "fin-t5"]), "opened: finished newest first (2000, 1800, 1500, 1000)");
check(text(find(tree, "fin-t6")).includes("exit 1") && text(find(tree, "fin-t7")).includes("stopped") && !text(find(tree, "fin-t5")).some((s) => s.startsWith("exit")), "exit 1 shown, stopped shown, a clean exit says nothing");
check(find(tree, "fin-t6").__h.tooltip.startsWith("exit 1 · ran 2s · ended "), `tooltip: ${find(tree, "fin-t6").__h.tooltip}`);
check(find(tree, "x-t6") === null, "no dismiss button until hovered");
find(tree, "fin-t6").__h.on_hover(true, cx); tree = m.render(cx);
check(find(tree, "x-t6") !== null, "hover shows the dismiss button in place of the time");
find(tree, "x-t6").__h.on_click(null, cx); tree = m.render(cx); rows = rowsOf(tree);
check(!rows.includes("fin-t6") && text(find(tree, "done-t1")).join("|").includes("3 finished") && !text(find(tree, "done-t1")).join("|").includes("failed"), "dismissed: gone, count 3, no failed left");
check(store.dismissed === '["t6"]', "dismissal kept in the mod's storage");
find(tree, "fin-t8").__h.on_click(null, cx);
check(overlays.at(-1)?.props?.thread?.name === "grandchild" && overlays.at(-1)?.props?.runs?.[0]?.address === "t8" && overlays.at(-1)?.props?.thread?.asker === "review-codex" && overlays.at(-1)?.kind === "dialog", "clicking a finished row opens its conversation; a sub-agent asked");
find(tree, "done-t1").__h.on_hover(true, cx); tree = m.render(cx);
find(tree, "clear-t1").__h.on_click(null, cx); tree = m.render(cx); rows = rowsOf(tree);
check(!rows.includes("done-t1"), "Clear finished hides the whole row");
// Reorder when a working one stops: t2 stops after the others did.
globalThis.__terms[1] = { ...globalThis.__terms[1], status: "idle" }; tree = m.render(cx); rows = rowsOf(tree);
check(JSON.stringify(rows) === JSON.stringify(["ag-t1", "sub-t2", "sub-t3", "sub-t4"]), "t2 stopped just now: newest end, stays on top");
globalThis.__terms[2] = { ...globalThis.__terms[2], status: "working" }; tree = m.render(cx); rows = rowsOf(tree);
check(rows[1] === "sub-t3", "t3 starts working again: working goes to the top");
// A sub-agent ending marks the list for a refresh from the core.
globalThis.__terms = globalThis.__terms.filter((k) => k.address !== "t4"); m.render(cx);
check(m.doneDirty === true, "a sub-agent leaving the live list asks the core again");
// The switch off: no finished row; the sort menu shows the switch.
shared["agents.finished"] = false; store.dismissed = "[]"; m.dismissed = new Set(); tree = m.render(cx);
check(!rowsOf(tree).includes("done-t1"), "switched off: no finished row");
P = { sortMenu: true, overlay: "ov2" }; const menu = new Mod(); menu.init(P, cx); const mt = menu.render(cx);
check(find(mt, "show-finished") !== null, "sort menu has the Finished sub-agents switch");
find(mt, "show-finished").__h.on_click(null, cx); check(shared["agents.finished"] === true, "the switch turns it back on");
// Narrow rail: no sub rows at all.
P = {}; globalThis.__g.layout = () => ({ id: "root", children: [{ id: "sidebar", size: { px: 44 } }] });

// Round 2: a name used twice, the dialog's size, the cut notice.
{
  P = {}; shared["agents.finished"] = true; globalThis.__g.layout = () => ({ id: "root", children: [{ id: "sidebar", size: { px: 250 } }] });
  for (const k of Object.keys(store)) delete store[k];
  const dup = [
    { address: "t20", state: "finished", parent: "t1", name: "review-codex", exit_code: 0, reason: "exited", created_ms: 1000, finished_ms: Date.UTC(2026, 10, 14, 9, 5) },
    { address: "t21", state: "finished", parent: "t1", name: "review-codex", exit_code: 0, reason: "exited", created_ms: 1000, finished_ms: Date.UTC(2026, 10, 14, 9, 45) },
    { address: "t22", state: "finished", parent: "t1", name: "review-kimi", exit_code: 0, reason: "exited", created_ms: 1000, finished_ms: Date.UTC(2026, 10, 14, 9, 30) },
  ];
  globalThis.__terms = [{ address: "t1", state: "live", program: prog("claude", "Claude"), status: "working" }];
  HC.ls = async () => ({ code: 0, stdout: JSON.stringify({ terminals: [...globalThis.__terms, ...dup] }), stderr: "" });
  const m2 = new Mod(); timers.length = 0; m2.init({}, cx); m2.render(cx); for (const f of timers) f(cx); await settle();
  let t2 = m2.render(cx); find(t2, "done-t1").__h.on_click(null, cx); t2 = m2.render(cx);
  const label = (id) => text(find(t2, id)).find((x) => x.startsWith("review-"));
  check(find(t2, "fin-t20") === null && label("fin-t21") === "review-codex" && label("fin-t22") === "review-kimi" && text(find(t2, "fin-t21")).includes("2"),
        `a follow-up under the same name joins its first run: one row, 2 rounds (${label("fin-t21")})`);
  check(text(find(t2, "done-t1")).join("|").includes("2 finished"), "the folded row counts conversations");
  find(t2, "fin-t21").__h.on_click(null, cx);
  check(overlays.at(-1).width === 0.8 && overlays.at(-1).height === 0.8, "the conversation is 80% of the window, like a running sub-agent's peek");
  check(JSON.stringify(overlays.at(-1).props.runs.map((k) => k.address)) === '["t20","t21"]' && overlays.at(-1).props.thread.asker === "Claude", "it gets both runs, oldest first, and who asked");
  // End to end: the window opened with exactly what the click gave it.
  P = { ...overlays.at(-1).props, overlay: "ov-e2e" };
  const e2e = new Mod(); e2e.init(P, cx); await settle(); const et = e2e.render(cx);
  const eall = text(et).join("|");
  check(e2e.rounds.length === 2 && e2e.rounds.every((r) => r.transcript?.startsWith("hello from")) && eall.includes("2 rounds · ran "),
    `opened from the list: 2 rounds, each with its output, the time it ran (${text(find(et, "conversation")).slice(0, 3).join(" / ")})`);
  const before = gets.length; m2.loadDone(cx); await settle();
  check(gets.length === before, "a finished record is asked for once, then kept");
}
// The conversation window.
{
  const T0 = Date.UTC(2026, 10, 14, 9, 0);
  const SID = "0199a213-81c0-7800-8aa1-bbab2c41ebaf";
  const req1 = ["Review the patch in /tmp/r1.diff for bugs.", ...Array.from({ length: 11 }, (_, i) => `point ${i + 1}`)].join("\n");
  const line = (dt, type, payload) => JSON.stringify({ timestamp: new Date(T0 + dt * 1000).toISOString(), type, payload });
  const msg = (role, texts, phase) => ({ type: "message", role, content: texts.map((t) => ({ type: role === "user" ? "input_text" : "output_text", text: t })), ...(phase ? { phase } : {}) });
  const rollout = [
    line(1, "session_meta", { id: SID, cwd: "/w", timestamp: new Date(T0 + 1000).toISOString() }),
    line(2, "response_item", msg("user", ["<environment_context>\n<cwd>/w</cwd>\n</environment_context>", req1])),
    line(5, "response_item", msg("assistant", ["Looking at the diff."], "commentary")),
    line(10, "response_item", { type: "function_call", name: "exec_command", arguments: "{}" }),
    line(30, "response_item", { type: "function_call", name: "exec_command", arguments: "{}" }),
    line(79, "response_item", msg("assistant", ["## Findings\n- an off-by-one in `parse`"], "final_answer")),
    line(301, "response_item", msg("user", ["Thanks. Now check the tests too, please."])),
    line(320, "response_item", { type: "custom_tool_call", name: "apply_patch" }),
    line(359, "response_item", msg("assistant", ["Tests look fine."], "final_answer")),
  ].join("\n");
  const parsed = thread.readRollout(rollout);
  check(parsed.id === SID && parsed.rounds.length === 2 && parsed.rounds[0].request === req1 && parsed.rounds[0].steps === 2
    && parsed.rounds[0].answer.startsWith("## Findings") && parsed.rounds[1].steps === 1, "codex session log: two rounds, codex's own context left out, final answers, steps counted");
  check(thread.requestFromArgv(["codex", "exec", "--full-auto", "Review the patch in /tmp/r1.diff please"]) === "Review the patch in /tmp/r1.diff please"
    && thread.requestFromArgv(["sh", "-c", "codex exec 'a long prompt that is here'"]) === null, "the request from a command line; none from a shell script");
  const st = thread.readRollout(line(1, "response_item", msg("user", ["Review this", "<stdin>\ndiff --git a b\n</stdin>"])));
  check(st.rounds[0].request.includes("<stdin>"), "piped input stays in the request");
  const g = thread.groupThreads([
    { address: "a1", parent: "t1", name: "rev", created_ms: 1 },
    { address: "a2", parent: "t1", name: "rev-2", labels: { "herdr.session": SID }, created_ms: 3 },
    { address: "a3", parent: "t1", name: "rev", labels: { "herdr.session": SID }, created_ms: 2 },
    { address: "a4", parent: "t1", created_ms: 4 },
    { address: "a5", parent: "t1", created_ms: 5 },
    { address: "a6", parent: "t2", name: "rev", created_ms: 6 },
  ]).map((th) => th.runs.map((k) => k.address));
  check(JSON.stringify(g) === '[["a1","a3","a2"],["a4"],["a5"],["a6"]]', `runs group by parent and name, joined by a shared session; unnamed ones stand alone: ${JSON.stringify(g)}`);

  EXEC = async (_cmd, args) => ({ code: 0, stdout: args.includes(SID) ? rollout : "", stderr: "" });
  HC.read = async (a) => ({ code: 0, stdout: JSON.stringify({ text: a[1] === "t30" ? `OpenAI Codex\n--------\nsession id: ${SID}\n--------\n` : "tests ran\n", complete: true }), stderr: "" });
  FILES["/tmp/b.md"] = "Tests look fine (from the answer file).";
  const codex = prog("codex", "Codex");
  const runsP = [
    { address: "t30", parent: "t1", name: "review-codex", argv: ["codex", "exec", req1], cwd: "/w", created_ms: T0, finished_ms: T0 + 80000, exit_code: 0, reason: "exited", program: codex },
    { address: "t31", parent: "t1", name: "review-codex", argv: ["codex", "exec", "resume", SID, "Thanks. Now check the tests too, please."], cwd: "/w",
      labels: { "herdr.session": SID, "herdr.answer": "/tmp/b.md" }, created_ms: T0 + 300000, finished_ms: T0 + 360000, exit_code: 0, reason: "exited", program: codex },
  ];
  P = { thread: { ...thread.threadOf(runsP), name: "review-codex", program: codex, asker: "Claude" }, runs: runsP, live: [], overlay: "ovc" };
  timers.length = 0;
  const c = new Mod(); c.init(P, cx);
  let ct = c.render(cx);
  check(text(ct).includes("Loading…"), "conversation: loading first");
  await settle(); ct = c.render(cx);
  const all = text(ct).join("|");
  check(all.includes("review-codex") && all.includes("2 rounds · ran 2m 20s") && all.includes("session 0199a213"), `header: name, rounds, time, session`);
  check(find(ct, "round-0") && find(ct, "round-1") && c.openRound === 1, "two rounds, the newest open");
  check(text(find(ct, "round-0")).some((x) => x.startsWith("Review the patch")), "a folded round shows its request's first line");
  const mdOf = (tree) => { const out = []; (function walk(n) { if (!n || typeof n !== "object") return; if (n.__md) out.push(n.__md); (n.__kids ?? []).forEach(walk); })(tree); return out; };
  check(JSON.stringify(mdOf(ct)) === JSON.stringify(["Tests look fine (from the answer file)."]), `the open round's answer as Markdown, the answer file over the log: ${JSON.stringify(mdOf(ct))}`);
  check(all.includes("Claude → review-codex") && all.includes("Thanks. Now check the tests too, please."), "the request in a quoted block: who asked whom");
  const key = (k) => find(ct, "conversation").__h.on_key_down({ key: k }, cx);
  key("up"); ct = c.render(cx);
  check(c.openRound === 0, "Up opens the round before");
  const all0 = text(ct).join("|");
  check(all0.includes("Show all 12 lines") && !all0.includes("point 11") && all0.includes("point 7"), "a long request shows 8 lines and Show all");
  check(JSON.stringify(mdOf(ct)) === JSON.stringify(["## Findings\n- an off-by-one in `parse`"]), "round 1's answer: codex's final answer from its log");
  find(ct, "request-all-0").__h.on_click(null, cx); ct = c.render(cx);
  check(text(ct).includes("point 11") && text(ct).includes("Show less"), "Show all unfolds it");
  check(text(find(ct, "work-0")).join(" ") === "Worked 1m 18s · 2 steps", `the work in one line: ${text(find(ct, "work-0")).join(" ")}`);
  find(ct, "work-0").__h.on_click(null, cx); ct = c.render(cx);
  check(find(ct, "step-0-0") !== null && text(find(ct, "step-0-0")).includes("Looking at the diff."), "the work line opens its steps from the log");
  find(ct, "terminal-0").__h.on_click(null, cx); ct = c.render(cx);
  check(editorOpts.at(-1).value.includes("session id"), "and the terminal's text is one click further");
  key("down"); key("down");
  check(c.openRound === 1, "Down stops at the newest");
  key("escape");
  check(closed.at(-1) === "ovc", "Esc closes");

  // A follow-up starts while the window is open, then ends.
  const live = { address: "t32", state: "live", parent: "t1", name: "review-codex", argv: ["codex", "exec", "resume", SID, "One more: check the docs as well."], cwd: "/w",
    created_ms: T0 + 600000, program: codex, status: "working" };
  globalThis.__terms = [{ address: "t1", state: "live" }, live];
  const core = runsP.map(({ program: _p, ...k }) => ({ ...k, state: "finished" }));
  HC.ls = async () => ({ code: 0, stdout: JSON.stringify({ terminals: [...core, live] }), stderr: "" });
  for (const f of timers) f(cx); await settle(); ct = c.render(cx);
  check(c.rounds.length === 3 && c.rounds[2].live && c.openRound === 2 && text(ct).includes("Working…") && text(ct).join("|").includes("One more: check the docs as well."),
    "a follow-up that starts shows up as a running round, opened");
  check(text(ct).join("|").includes("3 rounds · running"), "the header says it's running");
  find(ct, "watch-2").__h.on_click(null, cx);
  check(runs.at(-1)[0] === "terminal.peek" && runs.at(-1)[1].terminal === "t32", "Watch peeks at it");
  globalThis.__terms = [{ address: "t1", state: "live" }];
  const { program: _p, status: _s, ...ended } = live;
  HC.ls = async () => ({ code: 0, stdout: JSON.stringify({ terminals: [...core, { ...ended, state: "finished", finished_ms: T0 + 660000, exit_code: 0, reason: "exited" }] }), stderr: "" });
  for (const f of timers) f(cx); await settle(); ct = c.render(cx);
  check(c.rounds.length === 3 && !c.rounds[2].live && c.runs.length === 3 && c.runs[2].program?.key === "codex" && text(ct).includes("Output (no separate answer was recorded)"),
    "when it ends, the round shows its output; its program is kept");
  check(!text(ct).join("|").includes("running"), "and the header no longer says running");

  // A run with no log and no labels: its command line and its output.
  HC.read = async () => ({ code: 0, stdout: JSON.stringify({ text: "kimi says: all good\n", complete: true }), stderr: "" });
  const kimi = prog("kimi", "Kimi");
  const kimiRun = { address: "t40", parent: "t1", name: "review-kimi", argv: ["kimi", "--print", "-c", "Review the patch in /tmp/r1.diff for bugs."], cwd: "/w",
    created_ms: T0, finished_ms: T0 + 50000, exit_code: 1, reason: "exited", program: kimi };
  P = { thread: { ...thread.threadOf([kimiRun]), name: "review-kimi", program: kimi, asker: "Claude" }, runs: [kimiRun], live: [], overlay: "ovk" };
  const kc = new Mod(); kc.init(P, cx); await settle(); const kt = kc.render(cx);
  const kall = text(kt).join("|");
  check(kall.includes("Review the patch in /tmp/r1.diff for bugs.") && kall.includes("Output (no separate answer was recorded)") && editorOpts.at(-1).value === "kimi says: all good",
    "no log or labels: the request from its command line, its output in place of an answer");
  check(kall.includes("exit 1") && !kall.includes("session "), "a failed run says so; no session to show");
  FILES["/tmp/k-req.md"] = "Please review.\nCarefully."; FILES["/tmp/k-ans.md"] = "**LGTM**";
  const labeled = { ...kimiRun, address: "t41", labels: { "herdr.request": "/tmp/k-req.md", "herdr.answer": "/tmp/k-ans.md" } };
  P = { ...P, runs: [labeled], thread: { ...P.thread, addresses: ["t41"] } };
  const lc = new Mod(); lc.init(P, cx); await settle(); const lt = lc.render(cx);
  check(text(lt).includes("Carefully.") && mdOf(lt)[0] === "**LGTM**", "label files give the request and the answer");
}
// The agents' own logs, read by the real shell scripts from fixture homes.
{
  const { spawnSync } = await import("child_process");
  const meta = JSON.parse(fs.readFileSync(`${dir}/fixhome/meta.json`, "utf8"));
  HOME_DIR = `${dir}/fixhome`;
  const sizes = [];
  EXEC = async (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, KIMI_SHARE_DIR: "" } });
    sizes.push([args[1].slice(0, 12), r.stdout.length]);
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  HC.read = async () => ({ code: 0, stdout: JSON.stringify({ text: "some output\n", complete: true }), stderr: "" });
  const codex = prog("codex", "Codex"); const kimi = prog("kimi", "Kimi");

  // codex: no label, no session id on screen: found by folder and time, read from its log.
  const cRun = { address: "t50", parent: "t1", name: "review-codex", argv: ["codex", "exec", "Review the patch in /tmp/r1.diff for bugs."], cwd: "/w",
    created_ms: meta.CT0 * 1000, finished_ms: (meta.CT0 + 80) * 1000, exit_code: 0, reason: "exited", program: codex };
  const [cr] = await thread.loadConversation([cRun]);
  const kinds = (r) => r.work.map((s) => `${s.kind}:${s.text}`);
  console.log("  codex steps:", JSON.stringify(kinds(cr)));
  check(cr.session === meta.SID && cr.request === "Review the patch in /tmp/r1.diff for bugs." && cr.answer === "## Findings\n- an off-by-one in `parse`",
    "codex: its session found by folder and time; request and final answer from its log");
  check(JSON.stringify(kinds(cr)) === JSON.stringify([
    "think:Inspecting the allocator", 'run:rg -n "reserved(" src/', "say:Looking closer at the level 3 matcher.", "edit:src/terms.rs, src/new.rs",
    "search:pthread_cond_timedwait spurious wakeup", "run:cargo test -q …"]) && cr.steps === 4 && cr.tokens === 53200,
    "codex: each step in order (headline, commands, commentary, edited files, search), 4 steps, 53,200 tokens");
  check(cr.work[0].detail.includes("I'll look at how reserved keys") && cr.work[5].detail === "cargo test -q\necho done", "a step's whole text is kept for its tooltip");
  const codexBytes = sizes.find(([s]) => s.startsWith("id=$1"))?.[1];
  check(codexBytes < 20000, `codex: tool output, instructions and encrypted reasoning are left out before reading (${codexBytes} of 777,687 bytes read)`);

  // kimi: found by folder and time, its tool output stripped on the way.
  const kRun = { address: "t60", parent: "t1", name: "review-kimi", argv: ["kimi", "--print", "-p", "Review the staged changes for false positives."], cwd: "/w",
    created_ms: Math.round(meta.T0 * 1000), finished_ms: Math.round((meta.T0 + 83) * 1000), exit_code: 0, reason: "exited", program: kimi };
  sizes.length = 0;
  const [kr] = await thread.loadConversation([kRun]);
  console.log("  kimi steps:", JSON.stringify(kinds(kr)));
  check(kr.session === meta.KID && kr.request === "Review the staged changes for false positives.\nFocus on level 2."
    && kr.answer === "**Verdict:** two real problems.\n\n1. T9 fires on aliases.", "kimi: its session found (its own folder over a session started at the same time); request and answer from its log");
  check(JSON.stringify(kinds(kr)) === JSON.stringify(["think:The user wants a review of staging. Let me read the plan first.", "read:docs/plan.md",
    "say:I'll run the detector tests.", "run:pytest -q tests/test_detect.py"]) && kr.work[3].error === true && !kr.work[1].error && kr.steps === 2 && kr.tokens === 20300,
    "kimi: thinking, file read, what it said, the failed command; 2 steps, 20,300 tokens");
  const kimiBytes = sizes.find(([s]) => s.startsWith("if [ -n"))?.[1];
  check(kimiBytes < 10000 && sizes.length >= 2, `kimi: tool output left out before reading (${kimiBytes} of 1,472,372 bytes read)`);
  // A follow-up names its session: no search.
  sizes.length = 0;
  const [fr] = await thread.loadConversation([{ ...kRun, address: "t61", argv: ["kimi", "--print", "-r", meta.KID, "-p", "and level 3?"] }]);
  check(fr.session === meta.KID && sizes.length === 1, "kimi -r <id>: the session from the command line, read at once");
  check(thread.requestFromArgv(["codex", "exec", "-c", "model=o3", "Review the patch in /tmp/r1.diff please"]) === "Review the patch in /tmp/r1.diff please",
    "codex's -c is a config setting, not the prompt");

  // The window.
  P = { thread: { ...thread.threadOf([kRun]), name: "review-kimi", program: kimi, asker: "Claude Code" }, runs: [kRun], live: [], overlay: "ovw" };
  const w = new Mod(); w.init(P, cx); await settle(); let wt = w.render(cx);
  check(text(find(wt, "work-0")).join(" ") === "Worked 1m 21s · 2 steps · 20.3k tokens", `work line: ${text(find(wt, "work-0")).join(" ")}`);
  check(find(wt, "step-0-0") === null, "steps start folded");
  find(wt, "work-0").__h.on_click(null, cx); wt = w.render(cx);
  check(find(wt, "step-0-3") !== null && text(find(wt, "step-0-3")).includes("failed") && text(find(wt, "step-0-0")).includes("0:02") && text(find(wt, "step-0-3")).includes("0:08"),
    `unfolded: one row per step, its time into the round, a failed command says so (${text(find(wt, "step-0-3")).join(" | ")})`);
  check(find(wt, "terminal-0") !== null && find(wt, "step-0-0").__h.tooltip?.includes("Then the code."), "the terminal output one click away; a step's tooltip has its whole text");
  find(wt, "terminal-0").__h.on_click(null, cx); wt = w.render(cx);
  check(editorOpts.at(-1).value === "some output" && editorOpts.at(-1).soft_wrap === true, "terminal output: its text, long lines wrapped");
  const mds = []; (function walk(n) { if (!n || typeof n !== "object") return; if (n.__md) mds.push(n.__md); (n.__kids ?? []).forEach(walk); })(wt);
  check(mds[0]?.startsWith("**Verdict:**"), "kimi's answer as Markdown");

  // Output only: the box fills the window.
  const plain = { ...kRun, address: "t70", argv: ["sh", "-c", "some-tool --go"], program: null, cwd: "/elsewhere" };
  P = { thread: { ...thread.threadOf([plain]), name: "plain", asker: "Claude Code" }, runs: [plain], live: [], overlay: "ovp" };
  const o = new Mod(); o.init(P, cx); await settle(); let ot = o.render(cx);
  const box = (tree) => { let h = null; (function walk(n) { if (!n || typeof n !== "object") return; if (n.__calls?.includes("border") && n.__kids.some((k) => k.__type === "editor")) h = n.__heights?.at(-1) ?? h; (n.__kids ?? []).forEach(walk); })(tree); return h; };
  find(ot, "conversation").__h.on_size_change({ width: 1600, height: 900 }, cx); ot = o.render(cx);
  check(box(ot) > 600, `output alone fills the window: a ${box(ot)} px box in a 900 px window`);
  HOME_DIR = "/home/u";
}
// Unknown element methods anywhere in what ran.
const unknown = [...used].filter((u) => !allowed.has(u));
check(unknown.length === 0, "every element method is known to gpui-kit or used by a shipped mod" + (unknown.length ? ": " + unknown.join(", ") : ""));
fs.rmSync(out, { recursive: true });
