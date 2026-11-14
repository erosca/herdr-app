// The bar over a working sub-agent's live terminal: who it is, how long it has run,
// and the request its parent sent it, quoted as its conversation quotes it. The
// terminal below is the real one: what the agent prints, as it prints it.
// Keys stay with this bar (Esc closes) until the terminal is clicked, so nothing typed
// by accident reaches the agent. When the agent ends, the window gives way to its
// conversation: the request, its work and its answer set out.
// Props: { watch: { thread, runs: [finished runs of the conversation], live: <its record> }, overlay }.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, run, closeOverlay, openOverlay, terminals, panes, hc } from "herdr";
import { liveRequest } from "./thread.js";
import { icon, span, conversationOf } from "./util.js";

// How often, and how many times, a request that isn't known yet is looked for (a log
// has it a few seconds after its agent starts).
const ASK_EVERY = 3;
const ASK_TIMES = 20;

// `given`: the bar's props; tests pass their own, with `request` already read.
export function initWatch(v, cx, given = props()) {
  const w = given?.watch ?? {};
  v.thread = w.thread ?? {};
  v.runs = w.runs ?? [];
  v.k = w.live ?? {};
  // undefined: still looked for; null: there is none to show.
  v.request = given?.request;
  v.tries = 0;
  v.ticks = 0;
  v.gone = 0;
  v.keys = cx.focus_handle();
  v.keys.focus();
  if (given?.request !== undefined) return;
  // The app hands the keyboard to the terminal as the window opens: taken back once.
  cx.timer.after(250, () => v.keys.focus());
  ask(v, cx);
  cx.timer.every(1000, (cx) => {
    v.ticks += 1;
    const live = terminals().some((k) => k.address === v.k.address && k.state === "live");
    // Not listed twice running: ended, if its core says so (a machine out of reach
    // leaves its terminals out of the list, too).
    v.gone = live ? 0 : v.gone + 1;
    if (v.gone >= 2 && !v.checking) return ended(v, cx);
    if (v.request === undefined && !v.asking && v.ticks % ASK_EVERY === 0) ask(v, cx);
    // The time it has run.
    if (v.ticks % 10 === 0) cx.notify();
  });
}

function ask(v, cx) {
  v.asking = true;
  v.tries += 1;
  cx.spawn(async (cx) => {
    const got = await liveRequest(v.k);
    if (got) v.request = got;
    else if (v.tries >= ASK_TIMES) v.request = null;
    v.asking = false;
    cx.notify();
  });
}

function ended(v, cx) {
  v.checking = true;
  cx.spawn(async () => {
    let finished = false;
    try {
      const r = await hc(["get", v.k.address, "--json"]);
      finished = r.code === 0 && JSON.parse(r.stdout).state === "finished";
    } catch (_) {
      // Its machine doesn't answer: the next second asks again.
    }
    v.checking = false;
    if (!finished || v.over) return;
    v.over = true;
    closeOverlay(props()?.overlay);
    openOverlay(conversationOf(v.thread, v.runs, [], true));
  });
}

const button = (t, id, label, onClick) => div()
  .id(id)
  .flex_none()
  .px(8)
  .py(2)
  .rounded(5)
  .text_size(11.5)
  .text_color(t.muted)
  .cursor_pointer()
  .hover((s) => s.bg(t.hover).text_color(t.foreground))
  .on_click(onClick)
  .child(label);

export function watchView(v, t) {
  const p = props() ?? {};
  const th = v.thread;
  const k = v.k;
  const pic = icon(th.program ?? k.program, 16, t.foreground);
  const home = panes().some((x) => x.terminal === k.address);
  const lines = (v.request ?? "").replace(/\s+$/, "").split("\n");
  return v_flex()
    .id("watch")
    .size_full()
    .bg(t.surface)
    .border_b(1)
    .border_color(t.border)
    .track_focus(v.keys)
    .on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      closeOverlay(p.overlay);
      cx.stop_propagation();
    })
    .child(h_flex()
      .h(40)
      .px(14)
      .gap(8)
      .flex_none()
      .items_center()
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child(th.name || k.name || k.address || ""))
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(k.created_ms != null ? `running ${span(Date.now() - k.created_ms)}` : "running"))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child("· its live terminal: click it to type into it"))
      // Its steps so far, from its own log, as its conversation lists them.
      .child(button(t, "watch-steps", "Steps", () => {
        closeOverlay(p.overlay);
        openOverlay(conversationOf(th, v.runs, [k]));
      }))
      .child(button(t, "watch-keep", home ? "↗ go to" : "↗ keep", () => {
        run(home ? "pane.focus" : "terminal.keep", { terminal: k.address });
        closeOverlay(p.overlay);
      }))
      .child(div()
        .id("watch-close")
        .p(3)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(p.overlay))
        .child(svg("mods/workspace-chrome/x.svg").size(13))))
    // The request: its first lines in view, the rest by scrolling.
    .child(v_flex().flex_1().min_h(0).px(14).pb(8)
      .child(v_flex()
        .id("watch-request")
        .flex_1()
        .min_h(0)
        .gap(3)
        .px(12)
        .py(9)
        .rounded(6)
        .bg(t.raised)
        .border_l(2)
        .border_color(t.accent)
        .overflow_y_scrollbar()
        .child(div().text_size(11).text_color(t.dim).child(`${th.asker || "Parent"} → ${th.name || k.name || ""}`))
        .when(v.request === undefined, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("Reading its request…")))
        .when(v.request === null, (el) => el.child(div().text_size(12.5).text_color(t.dim).child("The request wasn't recorded.")))
        .when(Boolean(v.request), (el) => el.children(lines.map((l) => div().text_size(12.5).text_color(t.foreground).child(l || " "))))));
}
