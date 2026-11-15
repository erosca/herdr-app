// The conversation window of a sub-agent: one round per request its parent sent, the
// same window while it works and once it is done. It only reads: nothing typed here
// reaches the agent, which takes its requests from its parent alone.
//
// Each round shows the request its parent sent (a quoted block, as Markdown, its first
// lines with the rest a click away), then
//   - while it works: how long and how far (from the agent's own log), what it is doing
//     now, and what it prints, as it prints it: read from its terminal every second,
//     selectable, the newest line at the bottom until the reader scrolls up, drags the
//     scroll bar or presses in it to select (then it holds still);
//   - once done: its work folded into one line (inside: each step from the agent's own
//     log, its terminal output) and its answer as Markdown. A round that ends while the
//     window is open turns into this in place.
// Nothing pops up on hover. Up and Down move between rounds; Page Up, Page Down and
// Home scroll the output, End follows its newest line again; Esc closes.
// Props: { thread: { name, program, asker, parent, names, sessions, addresses },
//          runs: [finished run records], live: [running ones], find?, overlay },
//     or { conversation: <a running sub-agent's address>, overlay }.
// A round's `note` says what couldn't be found or read, under its request.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, closeOverlay, settings, terminals, hc } from "herdr";
import { finishedRounds, liveRounds, liveOutput, inOrder, belongs, fullRecord, threadOf, requestFromArgv, agentOf } from "./thread.js";
import { icon, ending, span, clock, shownName } from "./util.js";

// A request shows this much until it is unfolded.
const SHOWN_LINES = 8;
const SHOWN_CHARS = 900;
const MAX_STEPS = 400;
// How often a round still going has its log read again (ms); its output is read every second.
const EVERY = 3000;
// The output's text size, and about how tall a line of it is (for scrolling by lines).
const OUT_SIZE = 12;
const LINE = 18;
const ICONS = { run: "terminal", read: "file-text", edit: "square-pen", search: "search", fetch: "monitor", plan: "circle-check", tool: "settings" };
const CUT = "Earlier output isn't kept: herdr-core keeps the last 1,000 lines of a finished sub-agent.";

const liveKey = (list) => list.map((k) => k.address).sort().join(" ");
const why = (e) => String(e?.message ?? e).split("\n")[0];

// A running sub-agent by its address alone: its conversation, and who it answers to.
function byAddress(address) {
  const all = terminals();
  const k = all.find((x) => x.address === address);
  if (!k) return { thread: { name: "", addresses: address ? [address] : [] }, runs: [], live: [] };
  const parent = all.find((x) => x.address === k.parent);
  return { thread: { ...threadOf([k]), name: shownName(k) || k.program?.name || k.address, program: k.program ?? null,
    asker: parent?.program?.name || parent?.name || "Parent" }, runs: [], live: [k] };
}

// A round still going, before its log is read: its request when its command line has it.
const waiting = (k) => ({ run: k, live: true, done: false, pending: true, at: k.created_ms ?? null, end: null,
  request: requestFromArgv(k.argv, agentOf(k)), answer: null, work: [], steps: null, tokens: null, cached: null,
  ended: null, model: null, effort: null, session: null, note: null, transcript: null, cut: false });

// What a running one printed, as the window keeps it: its lines; whether the panel
// follows the newest, else how many lines are below what it shows (`back`); a drag of
// its scroll bar under way; the wheel's part of a line not scrolled yet; how many lines
// the panel takes at most (`fit`, from its last frame: scrolling stops where the first
// line is in view).
const output = () => ({ lines: [], at: 0, follow: true, back: 0, drag: false, wheel: 0, fit: 1, reading: false, error: null, copied: 0 });

// `given`: the window's props; tests pass their own, with `rounds` already read.
export function initConversation(v, cx, given = props()) {
  const asked = given ?? {};
  const p = asked.thread ? asked : { ...asked, ...byAddress(asked.conversation) };
  v.thread = p.thread ?? {};
  v.runs = p.runs ?? [];
  v.live = p.live ?? [];
  // The core's finished records don't say which program ran: kept from the list.
  v.programs = {};
  for (const k of [...v.runs, ...v.live]) if (k.program) v.programs[k.address] = k.program;
  v.rounds = null;
  // What was read: each finished run's rounds (once), and where each running one's log was read to.
  v.done = new Map();
  v.states = new Map();
  // What each running one printed.
  v.out = new Map();
  // What's open and unfolded, by round (its `key`: its run and its place among that run's rounds).
  v.open = null;
  v.full = new Set();
  v.work = new Set();
  v.term = new Set();
  // Steps unfolded to their whole text, by round and place.
  v.steps = new Set();
  // Measured heights, for the output panel to fill what the window leaves.
  v.tops = new Map();
  v.editors = new Map();
  v.size = null;
  v.keys = cx.focus_handle();
  v.keys.focus();
  v.seen = liveKey(v.live);
  v.at = 0;
  if (p.rounds) return show(v, p.rounds);
  // A round still going shows at once, and its output with it; the rest follows.
  if (v.live.length) {
    show(v, v.live.map(waiting));
    for (const k of v.live) readOutput(v, cx, k);
  }
  // With a run still going, opened by address alone or told to (`find`), the
  // conversation's finished runs are asked of the core first: the list the window was
  // opened from may lack them.
  if (v.live.length || !asked.thread || asked.find) refresh(v, cx, v.live);
  else load(v, cx);
  cx.timer.every(1000, (cx) => tick(v, cx));
}

function tick(v, cx) {
  if (!v.loading) {
    const live = terminals().filter((k) => k.state === "live" && belongs(v.thread, k));
    // A follow-up starting, or a running round ending: read the conversation's runs again.
    if (liveKey(live) !== v.seen) {
      v.seen = liveKey(live);
      refresh(v, cx, live);
    } else if (v.live.length && Date.now() - v.at >= EVERY) load(v, cx);
  }
  for (const k of v.live) readOutput(v, cx, k);
  // The time it has run, while a round runs.
  if (v.live.length) cx.notify();
}

// Reads what isn't read yet: finished runs once, running ones on from the last look.
function load(v, cx) {
  v.loading = true;
  cx.spawn(async (cx) => {
    try {
      // Records from the list lack their times and command line: the header needs them.
      v.runs = await Promise.all(v.runs.map(fullRecord));
      const todo = v.runs.filter((k) => !v.done.has(k.address));
      const reading = Promise.all(todo.map(finishedRounds));
      const live = v.live;
      const going = await Promise.all(live.map((k) => liveRounds(k, v.states.get(k.address) ?? null)));
      live.forEach((k, i) => v.states.set(k.address, going[i].state));
      const all = () => inOrder([...v.runs.map((k) => v.done.get(k.address) ?? []), ...going.map((g) => g.rounds)]);
      // The round still going shows at once; the finished ones join it as they are read.
      if (live.length && todo.length) {
        show(v, all());
        cx.notify();
      }
      const read = await reading;
      todo.forEach((k, i) => v.done.set(k.address, read[i]));
      show(v, all());
    } catch (_) {
      if (v.rounds === null) show(v, []);
    }
    v.loading = false;
    v.at = Date.now();
    cx.notify();
  });
}

function show(v, rounds) {
  const newest = v.rounds?.[v.rounds.length - 1]?.key ?? null;
  const first = v.rounds === null;
  const nth = {};
  for (const r of rounds) {
    const a = r.run?.address ?? "";
    nth[a] = (nth[a] ?? 0) + 1;
    r.key = `${a}#${nth[a]}`;
  }
  // Each round's terminal text gets its view here: the engine doesn't let a render make
  // one. A view stays across refreshes, so its scroll position does.
  const kept = new Set();
  for (const r of rounds) {
    if (!r.transcript) continue;
    kept.add(r.key);
    const had = v.editors.get(r.key);
    if (!had) {
      v.editors.set(r.key, { text: r.transcript, state: EditorState.new({ language: "text", value: r.transcript, readonly: true, line_numbers: false,
        folding: false, soft_wrap: true, font_family: settings().font_family, font_size: 12 }) });
    } else if (had.text !== r.transcript) {
      had.state.set_value(r.transcript);
      had.text = r.transcript;
    }
  }
  for (const k of [...v.editors.keys()]) if (!kept.has(k)) v.editors.delete(k);
  v.rounds = rounds;
  // Opens the newest round, unless the person is reading an earlier one or closed it.
  if (first || (v.open !== null && v.open === newest)) v.open = rounds[rounds.length - 1]?.key ?? null;
}

function refresh(v, cx, live) {
  v.loading = true;
  cx.spawn(async (cx) => {
    try {
      const r = await hc(["ls", "--all", "--json"]);
      const list = r.code === 0 ? JSON.parse(r.stdout).terminals ?? [] : [];
      const finished = await Promise.all(list.filter((k) => k.state === "finished" && belongs(v.thread, k)).map(fullRecord));
      for (const k of live) if (k.program) v.programs[k.address] = k.program;
      const named = (k) => ({ ...k, program: k.program ?? v.programs[k.address] ?? v.thread.program ?? null });
      // A run the core has forgotten stays as it was.
      const known = new Set(finished.map((k) => k.address));
      v.runs = [...v.runs.filter((k) => !known.has(k.address)), ...finished.map(named)]
        .sort((x, y) => (x.created_ms ?? 0) - (y.created_ms ?? 0));
      v.live = live.map(named);
      // A run that ended is read whole, as a finished one; what it printed is in that round.
      const going = new Set(v.live.map((k) => k.address));
      for (const a of [...v.states.keys()]) if (!going.has(a)) v.states.delete(a);
      for (const a of [...v.out.keys()]) if (!going.has(a)) v.out.delete(a);
      v.thread = { ...v.thread, addresses: [...new Set([...(v.thread.addresses ?? []), ...v.runs.map((k) => k.address), ...v.live.map((k) => k.address)])] };
    } catch (_) {
      // The next change tries again.
    }
    load(v, cx);
  });
}

// --- what a running one prints ---------------------------------------------------------

/** What a running one printed, as a test hands it in: the panel as it would show it. */
export function setOutput(v, address, text, { back = 0 } = {}) {
  const o = output();
  o.lines = text.split("\n");
  o.at = Date.now();
  scrollTo(o, back);
  v.out.set(address, o);
  return o;
}

function readOutput(v, cx, k) {
  let o = v.out.get(k.address);
  if (!o) {
    o = output();
    v.out.set(k.address, o);
  }
  if (o.reading) return;
  o.reading = true;
  cx.spawn(async (cx) => {
    try {
      const got = await liveOutput(k, o.lines);
      o.error = null;
      if (got.from < got.lines.length || got.lines.length !== o.lines.length) {
        // Held still, the panel keeps showing the same lines while more come below.
        if (!o.follow) o.back += Math.max(0, got.lines.length - o.lines.length);
        o.lines = got.lines;
        o.at = Date.now();
      }
    } catch (e) {
      o.error = why(e);
    }
    o.reading = false;
    cx.notify();
  });
}

// Shows the output with `back` lines below the panel's bottom; none: it follows again.
function scrollTo(o, back) {
  o.back = Math.max(0, Math.min(Math.round(back), o.lines.length - o.fit));
  o.follow = o.back === 0;
}

// The wheel, in lines: toward the start of the output, or back down to its end.
function wheel(o, e) {
  o.wheel += (e.delta?.y ?? 0) / LINE;
  const step = Math.trunc(o.wheel);
  if (!step) return false;
  o.wheel -= step;
  scrollTo(o, o.back + step);
  return true;
}

// The scroll bar's track, in the panel: from 4 px below its top to 4 px above its bottom.
function bar(o, height, seen) {
  const total = o.lines.length;
  const track = height - 8;
  const thumb = Math.max(24, track * Math.min(1, seen / Math.max(1, total)));
  const above = Math.max(0, total - o.back - seen);
  const room = Math.max(1, total - seen);
  return { track, thumb, top: 4 + (track - thumb) * Math.min(1, above / room), room };
}

// A press or drag on the track at `y` (in the panel): the thumb's middle goes there.
function dragTo(o, y, height, seen) {
  const b = bar(o, height, seen);
  const at = Math.max(0, Math.min(1, (y - 4 - b.thumb / 2) / Math.max(1, b.track - b.thumb)));
  scrollTo(o, o.lines.length - Math.round(at * b.room) - seen);
}

// Text that shows as it is: each line one line, its spaces kept, nothing in it read as Markdown.
const PUNCTUATION = /[!-/:-@[-`{-~]/g;
const literal = (lines) => lines.map((l) => {
  const lead = l.match(/^ */)[0].length;
  const text = "\u00a0".repeat(lead) + l.slice(lead).replace(PUNCTUATION, "\\$&").replace(/ {2}/g, " \u00a0");
  return text || "\u00a0";
}).join("\\\n");

function key(v, e, cx) {
  const rounds = v.rounds ?? [];
  if (e.key === "escape") {
    closeOverlay(props().overlay);
    cx.stop_propagation();
    return;
  }
  // The output of the round open, while it runs: End follows it, the others scroll it.
  const r = rounds.find((x) => x.key === v.open);
  const o = r?.live && !r.done ? v.out.get(r.run.address) : null;
  if (o && ["end", "home", "pageup", "pagedown"].includes(e.key)) {
    const page = Math.max(1, Math.floor((panelHeight(v, r, rounds.indexOf(r)) - 12) / LINE) - 2);
    scrollTo(o, e.key === "end" ? 0 : e.key === "home" ? o.lines.length : o.back + (e.key === "pageup" ? page : -page));
    cx.stop_propagation();
    cx.notify();
    return;
  }
  if (!rounds.length) return;
  const at = rounds.findIndex((r) => r.key === v.open);
  let to;
  if (e.key === "up") to = Math.max(0, (at < 0 ? rounds.length : at) - 1);
  else if (e.key === "down") to = Math.min(rounds.length - 1, at + 1);
  else return;
  v.open = rounds[to].key;
  cx.stop_propagation();
  cx.notify();
}

// --- the window ---------------------------------------------------------------------------

const modelOf = (r) => [r.model, r.effort].filter(Boolean).join(" ");

export function conversationView(v, t) {
  const p = props() ?? {};
  const th = v.thread;
  const runs = v.runs;
  const last = runs[runs.length - 1];
  const going = v.live[v.live.length - 1];
  const rounds = v.rounds;
  const n = rounds ? rounds.length : runs.length + v.live.length;
  const ran = runs.reduce((sum, r) => sum + Math.max(0, (r.finished_ms ?? r.created_ms ?? 0) - (r.created_ms ?? 0)), 0);
  const end = going ? { text: "running", bad: false } : last ? ending(last) : null;
  const facts = [`${n} ${n === 1 ? "round" : "rounds"}`, end?.text, ran ? `ran ${span(ran)}` : null].filter(Boolean);
  let session = null;
  let model = "";
  for (const r of rounds ?? []) {
    session = r.session ?? session;
    model = modelOf(r) || model;
  }
  const pic = icon(th.program, 16, t.foreground);
  return v_flex()
    .id("conversation")
    .size_full()
    .bg(t.surface)
    .track_focus(v.keys)
    .on_key_down((e, cx) => key(v, e, cx))
    // A scroll bar let go of anywhere in the window, not only over its panel.
    .on_mouse_up("left", (_e, cx) => {
      let was = false;
      for (const o of v.out.values()) {
        was = was || o.drag;
        o.drag = false;
      }
      if (was) cx.notify();
    })
    // The output panel fills what the window leaves.
    .on_size_change((size, cx) => {
      v.size = size;
      cx.notify();
    })
    .child(h_flex()
      .h(40)
      .px(14)
      .gap(8)
      .flex_none()
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(th.name || last?.name || going?.name || ""))
      .when(Boolean(model), (el) => el.child(div().flex_none().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(model)))
      .when(Boolean(going), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(end?.bad ? t.blocked : t.dim).child(facts.join(" · ")))
      .when(Boolean(session), (el) => el.child(div()
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .child(`session ${String(session).replace(/^session_/, "").slice(0, 8)}`)))
      .child(div()
        .id("conversation-close")
        .p(3)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(p.overlay))
        .child(svg("mods/workspace-chrome/x.svg").size(13))))
    .child(v_flex()
      .id("rounds")
      .flex_1()
      .min_h(0)
      .px(14)
      .py(10)
      .gap(2)
      .overflow_y_scrollbar()
      .children(rounds === null
        ? [div().p(4).text_size(12).text_color(t.dim).child("Loading…")]
        : rounds.length
          ? rounds.map((r, i) => roundView(v, t, r, i, rounds))
          : [div().p(4).text_size(12).text_color(t.dim).child("Nothing was recorded for this sub-agent.")]));
}

function roundView(v, t, r, i, rounds) {
  const open = v.open === r.key;
  // Still at it: its run goes on and its turn isn't over.
  const busy = r.live && !r.done;
  const first = (r.request ?? "").split("\n").find((l) => l.trim()) ?? "";
  const took = r.end != null && r.at != null ? span(r.end - r.at) : null;
  const end = r.run && !r.live ? ending(r.run) : null;
  const prev = rounds[i - 1];
  const fresh = i > 0 && r.session && prev?.session && r.session !== prev.session;
  const when = busy ? (r.at != null ? `running ${span(Date.now() - r.at)}` : "running") : took;
  const head = h_flex()
    .id(`round-${r.key}`)
    .h(28)
    .px(6)
    .gap(8)
    .flex_none()
    .rounded(6)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      v.open = open ? null : r.key;
      cx.notify();
    })
    .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
    .child(div().flex_none().text_size(12).font_medium().text_color(open ? t.foreground : t.muted).child(`Round ${i + 1}`))
    .child(div().flex_none().text_size(11.5).text_color(t.dim)
      .child([r.at != null ? clock(r.at) : null, when, modelOf(r) || null].filter(Boolean).join(" · ")))
    // Its parent started it over: the sub-agent didn't remember the rounds before.
    .when(Boolean(fresh), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("· new session")))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(open ? "" : first))
    .when(Boolean(r.live), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
    .when(Boolean(end), (el) => el.child(div().flex_none().text_size(11).text_color(end.bad ? t.blocked : t.dim).child(end.text)));
  if (!open) return head;
  if (busy) {
    return v_flex()
      .flex_none()
      .gap(6)
      .pb(12)
      .child(head)
      .child(v_flex().pl(25).pr(6).gap(10)
        // What's above the output, measured: the panel takes the rest of the window.
        .child(v_flex()
          .id(`top-${r.key}`)
          .gap(10)
          .on_size_change((size, cx) => {
            if (v.tops.get(r.key) === size.height) return;
            v.tops.set(r.key, size.height);
            cx.notify();
          })
          .child(requestView(v, t, r))
          .when(Boolean(r.note), (el) => el.child(noteView(t, r)))
          .children(statusViews(v, t, r)))
        .children(outputViews(v, t, r, i)));
  }
  return v_flex()
    .flex_none()
    .gap(6)
    .pb(12)
    .child(head)
    .child(v_flex().pl(25).pr(6).gap(10)
      .child(requestView(v, t, r))
      .when(Boolean(r.note), (el) => el.child(noteView(t, r)))
      .children(answerViews(v, t, r, i, took)));
}

// The request's first lines, for a request folded: whole lines, a code block left open closed.
function shortened(text) {
  const lines = text.split("\n");
  const out = [];
  let chars = 0;
  let fenced = false;
  for (const l of lines) {
    if (out.length >= SHOWN_LINES || (out.length && chars + l.length > SHOWN_CHARS)) break;
    out.push(l.length > SHOWN_CHARS ? `${l.slice(0, SHOWN_CHARS)}…` : l);
    chars += l.length + 1;
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    if (l.length > SHOWN_CHARS) break;
  }
  if (out.length === lines.length && chars <= SHOWN_CHARS + 1) return null;
  if (fenced) out.push("```");
  return out.join("\n");
}

// A link-like button. Its press stays its own: a fold it sits in doesn't toggle, and no
// text selection starts. Its release goes on: a text selection ends on it, wherever the
// mouse is let go (stopped, the selection would go on following the mouse).
const link = (t, id, label, onClick) => div()
  .id(id)
  .flex_none()
  .px(6)
  .py(1)
  .ml(-6)
  .rounded(4)
  .text_size(11.5)
  .text_color(t.accent)
  .cursor_pointer()
  .hover((s) => s.bg(t.hover))
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click(onClick)
  .child(label);

// The request its parent sent, as its parent wrote it (Markdown), selectable; a long
// one folded to its first lines.
function requestView(v, t, r) {
  const th = v.thread;
  const text = (r.request ?? "").replace(/\s+$/, "");
  const all = v.full.has(r.key);
  const short = text ? shortened(text) : null;
  const lines = text.split("\n").length;
  return v_flex()
    .gap(4)
    .px(12)
    .py(9)
    .rounded(6)
    .bg(t.raised)
    .border_l(2)
    .border_color(t.accent)
    .child(div().text_size(11).text_color(t.dim).child(`${th.asker || "Parent"} → ${th.name ?? ""}`))
    .when(!text, (el) => el.child(div().text_size(12.5).text_color(t.dim).child(r.pending ? "Reading its request…" : "The request wasn't recorded.")))
    .when(Boolean(text), (el) => el.child(div().text_size(12.5).text_color(t.foreground)
      .child(TextView.markdown(`request-${r.key}`, short && !all ? short : text).selectable(true))))
    .when(Boolean(short), (el) => el.child(link(t, `request-all-${r.key}`, all ? "Show less" : `Show all ${lines} lines`, (_e, cx) => {
      all ? v.full.delete(r.key) : v.full.add(r.key);
      cx.notify();
    })));
}

// What couldn't be found or read for this round, in a line.
const noteView = (t, r) => div().text_size(11).text_color(t.dim).child(r.note);

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Tokens: what the model read anew and wrote. What it re-read from its cache each time
// is far more and says little: named only where there is room, in an open fold's line.
const facts = (r, lead, cache = false) => [lead, r.steps != null ? `${r.steps} ${r.steps === 1 ? "step" : "steps"}` : null,
  r.tokens ? `${tokens(r.tokens)} tokens${cache && r.cached ? ` read anew and written, ${tokens(r.cached)} more re-read from cache` : ""}` : null].filter(Boolean).join(" · ");

// A round still going: how long and how far, from its log; what it is doing now; and
// whether it has been quiet (a long command, or an agent that is stuck).
function statusViews(v, t, r) {
  const o = v.out.get(r.run.address);
  const now = r.work?.[r.work.length - 1];
  const quiet = Date.now() - Math.max(o?.at ?? 0, r.seen ?? 0, r.at ?? 0);
  const copied = o && Date.now() - o.copied < 2000;
  const out = [h_flex()
    .gap(8)
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
    .child(div().flex_none().child(facts(r, r.at != null ? `Working ${span(Date.now() - r.at)}` : "Working")))
    .when(quiet >= 60000, (el) => el.child(div().flex_none().child(`· nothing new for ${span(quiet)}`)))
    .child(div().flex_1())
    .when(Boolean(o?.lines.length), (el) => el.child(link(t, `copy-${r.key}`, copied ? "Copied" : "Copy output", (_e, cx) => {
      cx.write_to_clipboard(o.lines.join("\n"));
      o.copied = Date.now();
      cx.notify();
    })))];
  if (now) {
    const say = now.kind === "say";
    out.push(h_flex()
      .gap(8)
      .items_center()
      .text_size(12)
      .child(div().flex_none().text_size(11).text_color(t.dim).child("Now"))
      .child(h_flex().w(14).h(12).flex_none().items_center().justify_center()
        .child(ICONS[now.kind] ? svg(`mods/workspace-chrome/${ICONS[now.kind]}.svg`).size(12).text_color(t.dim) : div().size(5).rounded(3).bg(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted)
        .when(now.kind === "run", (el) => el.font_family(settings().font_family))
        .child(say ? (now.detail ?? now.text).split("\n").find((l) => l.trim()) ?? now.text : now.text)));
  }
  return out;
}

// The output panel's height: what the window leaves under the request and the status.
function panelHeight(v, r, i) {
  const top = v.tops.get(r.key) ?? 160;
  const above = 41 + 10 + 30 * i + 28 + 6 + top + 10;
  const below = 10 + 16 + 12 + 10;
  return Math.max(220, (v.size?.height ?? 640) - above - below);
}

// What it prints, as it prints it: one selectable text, its newest line at the bottom of
// the panel (what doesn't fit is cut off at the top). Scrolled up, a scroll bar dragged
// or a press in it (a selection starting) holds it still; ↓ Latest or End follows again.
function outputViews(v, t, r, i) {
  const o = v.out.get(r.run.address);
  const height = panelHeight(v, r, i);
  const total = o?.lines.length ?? 0;
  // About how many lines are in view, and more than can be: the panel cuts off the rest.
  const seen = Math.max(1, Math.floor((height - 12) / LINE));
  // More lines than can be in view (short lines are short), the newest at the panel's
  // bottom and the rest cut off at its top; scrolled up to the first line, the first
  // lines at its top instead.
  const fit = Math.ceil(height / (OUT_SIZE * 1.15)) + 4;
  if (o) o.fit = fit;
  const end = total - (o?.back ?? 0);
  const start = Math.max(0, end - fit);
  const top = Boolean(o) && !o.follow && start === 0;
  const shown = o ? o.lines.slice(start, top ? Math.min(total, fit) : end) : [];
  const b = o && total > seen ? bar(o, height, seen) : null;
  const asker = v.thread.asker || "its parent";
  const empty = o?.error ? `Its output couldn't be read: ${o.error}` : o && !o.reading && total === 0 ? "Nothing printed yet." : "Reading its output…";
  return [
    div()
      .id(`panel-${r.key}`)
      .relative()
      .h(height)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.background)
      .overflow_hidden()
      .font_family(settings().font_family ?? "JetBrains Mono")
      .text_size(OUT_SIZE)
      .on_scroll_wheel((e, cx) => {
        if (o && wheel(o, e)) cx.notify();
      })
      // A press in the text is a selection starting: the text holds still.
      .on_mouse_down("left", (_e, cx) => {
        if (!o) return;
        o.drag = false;
        if (!o.follow) return;
        o.follow = false;
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!o?.drag || !e.local_position) return;
        dragTo(o, e.local_position.y, height, seen);
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (!o?.drag) return;
        o.drag = false;
        cx.notify();
      })
      // At least the panel's height: a short output starts at its top.
      .when(total > 0, (el) => el.child(div()
        .absolute()
        .left(0)
        .right(14)
        .when(top, (el) => el.top(0))
        .when(!top, (el) => el.bottom(0))
        .min_h(height - 2)
        .px(10)
        .py(6)
        .text_color(t.foreground)
        .child(TextView.markdown(`output-${r.key}`, literal(shown)).selectable(true))))
      .when(Boolean(b), (el) => el.child(div()
        .id(`bar-${r.key}`)
        .absolute()
        .top(4)
        .bottom(4)
        .right(3)
        .w(8)
        .cursor_pointer()
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          o.drag = true;
          if (e.local_position) dragTo(o, e.local_position.y + 4, height, seen);
          cx.notify();
        })
        .child(div().absolute().left(1).right(1).top(b.top - 4).h(b.thumb).rounded(4).bg(o.drag ? t.dim : t.input))))
      .when(Boolean(o) && !o.follow && total > 0, (el) => el.child(div()
        .id(`latest-${r.key}`)
        .absolute()
        .bottom(10)
        .right(22)
        .px(10)
        .py(3)
        .rounded(12)
        .bg(t.popover)
        .border(1)
        .border_color(t.input)
        .text_size(11.5)
        .text_color(t.foreground)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          scrollTo(o, 0);
          cx.notify();
        })
        .child(o.back > 0 ? `↓ Latest · ${o.back} more ${o.back === 1 ? "line" : "lines"}` : "↓ Latest")))
      .when(total === 0, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child(empty))),
    div().text_size(11).text_color(t.dim).child(`Read-only. To ask it something, ask ${asker}.`),
  ];
}

// The output box's height when it's all its round has: the window less what's above it.
function fillHeight(v, r, i) {
  const lines = (r.request ?? "").replace(/\s+$/, "").split("\n").length;
  const shown = v.full.has(r.key) ? lines : Math.min(lines, SHOWN_LINES);
  const request = 40 + shown * 17 + (lines > SHOWN_LINES ? 18 : 0);
  const above = 40 + 20 + 30 * (i + 1) + request + 30;
  return Math.max(260, (v.size?.height ?? 640) - above - 16);
}

function transcriptView(v, t, r, i, fill = false) {
  return v_flex()
    .gap(4)
    .when(r.cut, (el) => el.child(div().text_size(11).text_color(t.dim).child(CUT)))
    .child(v_flex().h(fill ? fillHeight(v, r, i) : 320).rounded(6).border(1).border_color(t.border).child(Editor.new(v.editors.get(r.key).state).flex_1().min_h(0)));
}

// Time into the round: 0:42, 12:05, 1:02:10.
function offset(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// One step: when, what kind (an icon; a dot for what it set out to do), and what. What
// it said along the way reads as its answer will: as Markdown, in full. A step cut to
// its first line (a long command, a thought) unfolds to the whole of it on a click.
function stepRow(v, t, r, s, key) {
  const icon = ICONS[s.kind];
  const think = s.kind === "think";
  const say = s.kind === "say";
  const more = !say && Boolean(s.detail);
  const whole = more && v.steps.has(key);
  const text = () => div().text_size(12)
    .when(s.kind === "run" || (whole && !think), (el) => el.font_family(settings().font_family))
    .text_color(think ? t.foreground : t.muted);
  return h_flex()
    .id(`step-${key}`)
    .gap(8)
    .min_h(20)
    .items_center()
    .when(more, (el) => el.cursor_pointer().on_click((_e, cx) => {
      whole ? v.steps.delete(key) : v.steps.add(key);
      cx.notify();
    }))
    .child(div().self_start().mt(3).w(40).flex_none().text_size(11).text_color(t.dim).child(s.at != null && r.at != null ? offset(s.at - r.at) : ""))
    .child(h_flex().self_start().mt(4).w(14).h(12).flex_none().items_center().justify_center()
      .child(icon
        ? svg(`mods/workspace-chrome/${icon}.svg`).size(12).text_color(s.error ? t.blocked : t.dim)
        : div().size(think ? 5 : 4).rounded(3).bg(think ? t.muted : t.dim)))
    .child(say
      ? div().flex_1().min_w(0).py(1).text_size(12.5).text_color(t.muted).child(TextView.markdown(`said-${key}`, s.detail ?? s.text).selectable(true))
      : whole
        ? v_flex().flex_1().min_w(0).py(1).children(s.detail.split("\n").map((l) => text().child(l || " ")))
        : text().flex_1().min_w(0).truncate().child(s.text))
    // How long it took, when that's worth a word, and how it failed.
    .when(s.ms >= 2000 && !s.error, (el) => el.child(div().self_start().mt(3).flex_none().text_size(11).text_color(t.dim).child(span(s.ms))))
    .when(Boolean(s.error), (el) => el.child(div().self_start().mt(3).flex_none().text_size(11).text_color(t.blocked).child(s.error === true ? "failed" : s.error)));
}

// Steps `from` on, each under the same name whatever else is shown: a row keeps its
// place and its selection while newer ones arrive.
const stepRows = (v, t, r, from) => r.work.slice(from).map((s, j) => stepRow(v, t, r, s, `${r.key}-${from + j}`));

// What it did, step by step, from its own log; its terminal output one click away.
function stepsView(v, t, r, i) {
  const hidden = Math.max(0, r.work.length - MAX_STEPS);
  const term = v.term.has(r.key);
  return v_flex()
    .gap(2)
    .py(2)
    .when(hidden > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${hidden} earlier steps aren't shown`)))
    .children(stepRows(v, t, r, hidden))
    .when(Boolean(r.transcript), (el) => el.child(link(t, `terminal-${r.key}`, term ? "Hide terminal output" : "Terminal output", (_e, cx) => {
      term ? v.term.delete(r.key) : v.term.add(r.key);
      cx.notify();
    }).mt(6)))
    .when(term && v.editors.has(r.key), (el) => el.child(transcriptView(v, t, r, i)));
}

function answerViews(v, t, r, i, took) {
  const steps = r.work?.length > 0;
  if (!r.answer) {
    if (steps) return [div().text_size(12).text_color(t.dim).child(`It ended without an answer${r.ended ? ` (${r.ended})` : ""}. What it did:`), stepsView(v, t, r, i)];
    if (!r.transcript) return [div().text_size(12).text_color(t.dim).child("Nothing was recorded for this round.")];
    return [div().text_size(11).text_color(t.dim).child("Output (no separate answer was recorded)"), transcriptView(v, t, r, i, true)];
  }
  const out = [];
  const shown = v.work.has(r.key);
  const copied = Date.now() - (v.copied?.get(r.key) ?? 0) < 2000;
  out.push(h_flex()
    .id(`work-${r.key}`)
    .gap(6)
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .when(steps || Boolean(r.transcript), (el) => el
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        shown ? v.work.delete(r.key) : v.work.add(r.key);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${shown ? "down" : "right"}.svg`).size(10).flex_none()))
    .child(div().flex_1().min_w(0).child(facts(r, took ? `Worked ${took}` : "Work", shown)))
    .child(link(t, `copy-answer-${r.key}`, copied ? "Copied" : "Copy answer", (_e, cx) => {
      cx.write_to_clipboard(r.answer);
      v.copied = v.copied ?? new Map();
      v.copied.set(r.key, Date.now());
      // "Copied" goes back to "Copy answer" a moment later.
      cx.timer.after(2100, (cx) => cx.notify());
      cx.notify();
    })));
  if (shown && (steps || v.editors.has(r.key))) out.push(steps ? stepsView(v, t, r, i) : transcriptView(v, t, r, i));
  out.push(div().text_size(13).text_color(t.foreground).child(TextView.markdown(`answer-${r.key}`, r.answer).selectable(true)));
  return out;
}
