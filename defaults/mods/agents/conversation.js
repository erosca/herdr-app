// The conversation window of a finished sub-agent: one round per request its parent
// sent. Each round shows the request (a quoted block), the work folded into one line
// (its terminal output inside), and the answer as Markdown. Older rounds start folded,
// the newest open; Up and Down move between rounds, Esc closes.
// Props: { thread: { name, program, asker, parent, names, sessions, addresses },
//          runs: [finished run records], live: [running ones], overlay }.
// While open it follows the conversation: a follow-up that starts or ends shows up.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, run, closeOverlay, settings, terminals, hc } from "herdr";
import { loadConversation, belongs } from "./thread.js";
import { icon, ending, span, clock } from "./util.js";

const SHOWN_LINES = 8;
const CUT = "Earlier output isn't kept: herdr-core keeps the last 1,000 lines of a finished sub-agent.";

const liveKey = (list) => list.map((k) => k.address).sort().join(" ");

export function initConversation(v, cx) {
  const p = props();
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
  v.editors = new Map();
  v.keys = cx.focus_handle();
  v.keys.focus();
  v.seen = liveKey(v.live);
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
      rounds = await loadConversation(v.runs, v.live);
    } catch (_) {
      rounds = v.rounds ?? [];
    }
    v.rounds = rounds;
    v.editors = new Map();
    // A round with no separate answer shows its output instead: ready its text view.
    rounds.forEach((r, i) => {
      if (!r.answer && !r.live && r.transcript) editor(v, r, i);
    });
    // Opens the newest round, unless the person is reading an earlier one.
    if (atEnd) v.openRound = rounds.length - 1;
    v.loading = false;
    cx.notify();
  });
}

function refresh(v, cx, live) {
  v.loading = true;
  cx.spawn(async (cx) => {
    try {
      const r = await hc(["ls", "--all", "--json"]);
      const list = r.code === 0 ? JSON.parse(r.stdout).terminals ?? [] : [];
      const finished = list.filter((k) => k.state === "finished" && belongs(v.thread, k));
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

function editor(v, r, i) {
  if (!v.editors.has(i)) {
    v.editors.set(i, EditorState.new({ language: "text", value: r.transcript, readonly: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 12 }));
  }
  return v.editors.get(i);
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
        .child(`session ${String(session).slice(0, 8)}`)))
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
    .child(v_flex().pl(25).pr(6).gap(10).child(requestView(v, t, r, i)).children(answerViews(v, t, r, i, took)));
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

function transcriptView(v, t, r, i) {
  return v_flex()
    .gap(4)
    .when(r.cut, (el) => el.child(div().text_size(11).text_color(t.dim).child(CUT)))
    .child(v_flex().h(320).rounded(6).border(1).border_color(t.border).child(Editor.new(editor(v, r, i)).flex_1().min_h(0)));
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
  if (!r.answer) {
    if (!r.transcript) return [div().text_size(12).text_color(t.dim).child("Nothing was recorded for this round.")];
    return [div().text_size(11).text_color(t.dim).child("Output (no separate answer was recorded)"), transcriptView(v, t, r, i)];
  }
  const out = [];
  const work = [took ? `Worked ${took}` : "Work", r.steps != null ? `${r.steps} ${r.steps === 1 ? "step" : "steps"}` : null].filter(Boolean).join(" · ");
  const shown = v.work.has(i);
  out.push(h_flex()
    .id(`work-${i}`)
    .gap(6)
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .when(Boolean(r.transcript), (el) => el
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        if (shown) v.work.delete(i);
        else {
          editor(v, r, i);
          v.work.add(i);
        }
        cx.notify();
      })
      .child(svg(`mods/workspace-chrome/chevron-${shown ? "down" : "right"}.svg`).size(10).flex_none()))
    .child(work));
  if (shown && r.transcript) out.push(transcriptView(v, t, r, i));
  out.push(div().text_size(13).text_color(t.foreground).child(TextView.markdown(`answer-${i}`, r.answer).selectable(true)));
  return out;
}
