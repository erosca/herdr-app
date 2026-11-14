// The conversation window of a finished sub-agent: one round per request its parent
// sent. Each round shows the request (a quoted block), the work folded into one line
// (inside: each step from the agent's own log, else its terminal output), and the
// answer as Markdown. Older rounds start folded,
// the newest open; Up and Down move between rounds, Esc closes.
// Props: { thread: { name, program, asker, parent, names, sessions, addresses },
//          runs: [finished run records], live: [running ones], overlay }.
// While open it follows the conversation: a follow-up that starts or ends shows up.
// A round's `note` says what couldn't be found or read, under its request.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, run, closeOverlay, settings, terminals, hc } from "herdr";
import { loadConversation, belongs, fullRecord } from "./thread.js";
import { icon, ending, span, clock } from "./util.js";

const SHOWN_LINES = 8;
const MAX_STEPS = 400;
const ICONS = { run: "terminal", read: "file-text", edit: "square-pen", search: "search", fetch: "monitor", plan: "circle-check", tool: "settings" };
const CUT = "Earlier output isn't kept: herdr-core keeps the last 1,000 lines of a finished sub-agent.";

const liveKey = (list) => list.map((k) => k.address).sort().join(" ");

// `given`: the window's props; tests pass their own, with `rounds` already read.
export function initConversation(v, cx, given = props()) {
  const p = given;
  v.thread = p.thread ?? {};
  v.runs = p.runs ?? [];
  v.live = p.live ?? [];
  // The core's finished records don't say which program ran: kept from the list.
  v.programs = {};
  for (const k of [...v.runs, ...v.live]) if (k.program) v.programs[k.address] = k.program;
  v.rounds = null;
  v.openRound = -1;
  v.full = new Set();
  v.work = new Set();
  v.term = new Set();
  v.editors = new Map();
  v.size = null;
  v.keys = cx.focus_handle();
  v.keys.focus();
  v.seen = liveKey(v.live);
  if (p.rounds) return show(v, p.rounds);
  load(v, cx);
  // A follow-up starting, or a running round ending: read the conversation again.
  cx.timer.every(2000, (cx) => {
    const live = terminals().filter((k) => k.state === "live" && belongs(v.thread, k));
    if (liveKey(live) === v.seen || v.loading) return;
    v.seen = liveKey(live);
    refresh(v, cx, live);
  });
}

function load(v, cx) {
  v.loading = true;
  cx.spawn(async (cx) => {
    const atEnd = v.rounds === null || v.openRound === v.rounds.length - 1;
    let rounds;
    try {
      // Records from the list lack their times and command line: the header needs them.
      v.runs = await Promise.all(v.runs.map(fullRecord));
      rounds = await loadConversation(v.runs, v.live);
    } catch (_) {
      rounds = v.rounds ?? [];
    }
    show(v, rounds, atEnd);
    v.loading = false;
    cx.notify();
  });
}

function show(v, rounds, atEnd = true) {
  v.rounds = rounds;
  // Each round's terminal text gets its view here: the engine doesn't let a render make one.
  v.editors = new Map();
  rounds.forEach((r, i) => {
    if (r.transcript) {
      v.editors.set(i, EditorState.new({ language: "text", value: r.transcript, readonly: true, line_numbers: false, folding: false,
        soft_wrap: true, font_family: settings().font_family, font_size: 12 }));
    }
  });
  // Opens the newest round, unless the person is reading an earlier one.
  if (atEnd) v.openRound = rounds.length - 1;
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
      v.thread = { ...v.thread, addresses: [...new Set([...(v.thread.addresses ?? []), ...v.runs.map((k) => k.address), ...v.live.map((k) => k.address)])] };
    } catch (_) {
      // The next change tries again.
    }
    load(v, cx);
  });
}

function key(v, e, cx) {
  const n = v.rounds?.length ?? 0;
  if (e.key === "escape") {
    closeOverlay(props().overlay);
    cx.stop_propagation();
    return;
  }
  if (!n) return;
  if (e.key === "up") v.openRound = Math.max(0, (v.openRound < 0 ? n : v.openRound) - 1);
  else if (e.key === "down") v.openRound = Math.min(n - 1, v.openRound + 1);
  else return;
  cx.stop_propagation();
  cx.notify();
}

export function conversationView(v, t) {
  const p = props();
  const th = v.thread;
  const runs = v.runs;
  const last = runs[runs.length - 1];
  const rounds = v.rounds;
  const n = rounds ? rounds.length : runs.length + v.live.length;
  const ran = runs.reduce((sum, r) => sum + Math.max(0, (r.finished_ms ?? r.created_ms ?? 0) - (r.created_ms ?? 0)), 0);
  const end = v.live.length ? { text: "running", bad: false } : last ? ending(last) : null;
  const facts = [`${n} ${n === 1 ? "round" : "rounds"}`, end?.text, ran ? `ran ${span(ran)}` : null].filter(Boolean);
  let session = null;
  for (const r of rounds ?? []) session = r.session ?? session;
  const pic = icon(th.program, 16, t.foreground);
  return v_flex()
    .id("conversation")
    .size_full()
    .bg(t.surface)
    .track_focus(v.keys)
    .on_key_down((e, cx) => key(v, e, cx))
    // An output with nothing else in its round fills what the window leaves.
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
      .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(th.name ?? ""))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(end?.bad ? t.blocked : t.dim).child(facts.join(" · ")))
      .when(Boolean(session), (el) => el.child(div()
        .id("session")
        .flex_none()
        .text_size(11)
        .text_color(t.dim)
        .tooltip(`Session ${session}`)
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
  const open = v.openRound === i;
  const first = (r.request ?? "").split("\n").find((l) => l.trim()) ?? "";
  const took = r.end != null && r.at != null ? span(r.end - r.at) : null;
  const end = r.run && !r.live ? ending(r.run) : null;
  const prev = rounds[i - 1];
  const fresh = i > 0 && r.session && prev?.session && r.session !== prev.session;
  const head = h_flex()
    .id(`round-${i}`)
    .h(28)
    .px(6)
    .gap(8)
    .flex_none()
    .rounded(6)
    .items_center()
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      v.openRound = open ? -1 : i;
      cx.notify();
    })
    .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
    .child(div().flex_none().text_size(12).font_medium().text_color(open ? t.foreground : t.muted).child(`Round ${i + 1}`))
    .child(div().flex_none().text_size(11.5).text_color(t.dim)
      .child([r.at != null ? clock(r.at) : null, r.live ? "running" : took].filter(Boolean).join(" · ")))
    // Its parent started it over: the sub-agent didn't remember the rounds before.
    .when(Boolean(fresh), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("· new session")))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(open ? "" : first))
    .when(r.live, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
    .when(Boolean(end), (el) => el.child(div().flex_none().text_size(11).text_color(end.bad ? t.blocked : t.dim).child(end.text)));
  if (!open) return head;
  return v_flex()
    .flex_none()
    .gap(6)
    .pb(12)
    .child(head)
    .child(v_flex().pl(25).pr(6).gap(10)
      .child(requestView(v, t, r, i))
      .when(Boolean(r.note), (el) => el.child(noteView(t, r)))
      .children(answerViews(v, t, r, i, took)));
}

function requestView(v, t, r, i) {
  const th = v.thread;
  const lines = (r.request ?? "").replace(/\s+$/, "").split("\n");
  const all = v.full.has(i);
  return v_flex()
    .gap(3)
    .px(12)
    .py(9)
    .rounded(6)
    .bg(t.raised)
    .border_l(2)
    .border_color(t.accent)
    .child(div().text_size(11).text_color(t.dim).child(`${th.asker || "Parent"} → ${th.name ?? ""}`))
    .when(!r.request, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("The request wasn't recorded.")))
    .when(Boolean(r.request), (el) => el.children((all ? lines : lines.slice(0, SHOWN_LINES))
      .map((l) => div().text_size(12.5).text_color(t.foreground).child(l || " "))))
    .when(Boolean(r.request) && lines.length > SHOWN_LINES, (el) => el.child(div()
      .id(`request-all-${i}`)
      .mt(2)
      .text_size(11.5)
      .text_color(t.accent)
      .cursor_pointer()
      .on_click((_e, cx) => {
        all ? v.full.delete(i) : v.full.add(i);
        cx.notify();
      })
      .child(all ? "Show less" : `Show all ${lines.length} lines`)));
}

// What couldn't be found or read for this round, in a line.
const noteView = (t, r) => div().text_size(11).text_color(t.dim).child(r.note);

// The output box's height when it's all its round has: the window less what's above it.
function fillHeight(v, r, i) {
  const lines = (r.request ?? "").replace(/\s+$/, "").split("\n").length;
  const shown = v.full.has(i) ? lines : Math.min(lines, SHOWN_LINES);
  const request = 40 + shown * 17 + (lines > SHOWN_LINES ? 18 : 0);
  const above = 40 + 20 + 30 * (i + 1) + request + 30;
  return Math.max(260, (v.size?.height ?? 640) - above - 16);
}

function transcriptView(v, t, r, i, fill = false) {
  return v_flex()
    .gap(4)
    .when(r.cut, (el) => el.child(div().text_size(11).text_color(t.dim).child(CUT)))
    .child(v_flex().h(fill ? fillHeight(v, r, i) : 320).rounded(6).border(1).border_color(t.border).child(Editor.new(v.editors.get(i)).flex_1().min_h(0)));
}

const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Time into the round: 0:42, 12:05, 1:02:10.
function offset(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// One step: when, what kind (an icon; a dot for what it set out to do), and what.
function stepRow(t, r, s, key) {
  const icon = ICONS[s.kind];
  const think = s.kind === "think";
  const say = s.kind === "say";
  const text = say ? (s.detail ?? s.text) : s.text;
  return h_flex()
    .id(`step-${key}`)
    .gap(8)
    .min_h(20)
    .items_center()
    .when(Boolean(s.detail) && !say, (el) => el.tooltip(s.detail))
    .child(div().self_start().mt(3).w(40).flex_none().text_size(11).text_color(t.dim).child(s.at != null && r.at != null ? offset(s.at - r.at) : ""))
    .child(h_flex().self_start().mt(4).w(14).h(12).flex_none().items_center().justify_center()
      .child(icon
        ? svg(`mods/workspace-chrome/${icon}.svg`).size(12).text_color(s.error ? t.blocked : t.dim)
        : div().size(think ? 5 : 4).rounded(3).bg(think ? t.muted : t.dim)))
    .child(say
      ? div().flex_1().min_w(0).py(1).text_size(12).text_color(t.muted).child(text)
      : div().flex_1().min_w(0).truncate().text_size(12)
        .when(s.kind === "run", (el) => el.font_family(settings().font_family))
        .text_color(think ? t.foreground : t.muted)
        .child(text))
    // How long it took, when that's worth a word, and how it failed.
    .when(s.ms >= 2000 && !s.error, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(span(s.ms))))
    .when(Boolean(s.error), (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(s.error === true ? "failed" : s.error)));
}

// What it did, step by step, from its own log; its terminal output one click away.
function stepsView(v, t, r, i) {
  const work = r.work.length > MAX_STEPS ? r.work.slice(-MAX_STEPS) : r.work;
  const hidden = r.work.length - work.length;
  const term = v.term.has(i);
  return v_flex()
    .gap(2)
    .py(2)
    .when(hidden > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${hidden} earlier steps aren't shown`)))
    .children(work.map((s, j) => stepRow(t, r, s, `${i}-${j}`)))
    .when(Boolean(r.transcript), (el) => el.child(div()
      .id(`terminal-${i}`)
      .mt(6)
      .text_size(11.5)
      .text_color(t.accent)
      .cursor_pointer()
      .on_click((_e, cx) => {
        term ? v.term.delete(i) : v.term.add(i);
        cx.notify();
      })
      .child(term ? "Hide terminal output" : "Terminal output")))
    .when(term && v.editors.has(i), (el) => el.child(transcriptView(v, t, r, i)));
}

function answerViews(v, t, r, i, took) {
  if (r.live) {
    return [h_flex()
      .gap(8)
      .items_center()
      .text_size(12)
      .text_color(t.muted)
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
      .child("Working…")
      .child(div()
        .id(`watch-${i}`)
        .px(8)
        .py(2)
        .rounded(5)
        .text_color(t.accent)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => {
          closeOverlay(props().overlay);
          run("terminal.peek", { terminal: r.run.address });
        })
        .child("Watch"))];
  }
  const steps = r.work?.length > 0;
  if (!r.answer) {
    if (steps) return [div().text_size(12).text_color(t.dim).child(`It ended without an answer${r.ended ? ` (${r.ended})` : ""}. What it did:`), stepsView(v, t, r, i)];
    if (!r.transcript) return [div().text_size(12).text_color(t.dim).child("Nothing was recorded for this round.")];
    return [div().text_size(11).text_color(t.dim).child("Output (no separate answer was recorded)"), transcriptView(v, t, r, i, true)];
  }
  const out = [];
  const facts = [took ? `Worked ${took}` : "Work", r.steps != null ? `${r.steps} ${r.steps === 1 ? "step" : "steps"}` : null,
    r.tokens ? `${tokens(r.tokens)} tokens` : null].filter(Boolean).join(" · ");
  // Tokens: what the model read anew and wrote. What it re-read from its cache each time is far more, and says little.
  const tip = r.tokens && r.cached ? `${tokens(r.tokens)} tokens read anew and written, ${tokens(r.cached)} more re-read from cache` : null;
  const shown = v.work.has(i);
  out.push(h_flex()
    .id(`work-${i}`)
    .gap(6)
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(steps || Boolean(r.transcript), (el) => el
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        shown ? v.work.delete(i) : v.work.add(i);
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${shown ? "down" : "right"}.svg`).size(10).flex_none()))
    .child(facts));
  if (shown && (steps || v.editors.has(i))) out.push(steps ? stepsView(v, t, r, i) : transcriptView(v, t, r, i));
  out.push(div().text_size(13).text_color(t.foreground).child(TextView.markdown(`answer-${i}`, r.answer).selectable(true)));
  return out;
}
