// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left. Sub-agents that finished stay under
// their agent in one folded "n finished" row while the core keeps them (a day after
// their parent saw the result), a follow-up under the same name with its first run;
// clicking one opens its conversation (conversation.js), dismissing hides it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, hc } from "herdr";
import { icon, ending, clock, about } from "./util.js";
import { initConversation, conversationView } from "./conversation.js";
import { groupThreads, threadOf, belongs, fullRecord } from "./thread.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Finished sub-agents are shown unless switched off in the sort menu.
const showFinished = () => shared("agents.finished") !== false;

// The tree lines in front of a sub-row: one 13 px column per level.
function connectors(t, lines) {
  return lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
    .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
    .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6)));
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.thread) return initConversation(this, cx);
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.timer.every(30000, (cx) => cx.notify());
    // Finished sub-agents: terminals() lists live terminals only, so they come from
    // the core, asked again when a sub-agent ends and every 5 minutes.
    this.done = [];
    this.doneAt = 0;
    this.doneDirty = true;
    this.records = {};
    this.openDone = new Set();
    this.dismissed = new Set(JSON.parse(localStorage.getItem("dismissed") ?? "[]"));
    // A sub-agent's program and name, kept from while it ran: the core's record has neither.
    this.progs = JSON.parse(localStorage.getItem("progs") ?? "{}");
    cx.timer.every(2000, (cx) => {
      if (showFinished() && (this.doneDirty || Date.now() - this.doneAt > 300000)) this.loadDone(cx);
    });
  }

  loadDone(cx) {
    if (this.loading) return;
    this.loading = true;
    this.doneDirty = false;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["ls", "--all", "--json"]);
        if (r.code !== 0) return;
        const list = JSON.parse(r.stdout).terminals ?? [];
        // The list's short form has no times, command line or labels: each finished
        // sub-agent's whole record is asked for once.
        const finished = list.filter((k) => k.state === "finished" && k.parent);
        const missing = finished.filter((k) => !this.records[k.address]);
        for (let i = 0; i < missing.length; i += 8) {
          for (const k of await Promise.all(missing.slice(i, i + 8).map(fullRecord))) {
            if (k.created_ms != null) this.records[k.address] = k;
          }
        }
        const known = new Set(list.map((k) => k.address));
        for (const a of Object.keys(this.records)) if (!known.has(a)) delete this.records[a];
        this.done = finished.map((k) => ({ ...this.records[k.address], ...k }));
        this.forget(list);
      } catch (_) {
        // Keep the last list: a core that's restarting answers again soon.
      } finally {
        this.loading = false;
        this.doneAt = Date.now();
        cx.notify();
      }
    });
  }

  // Drops dismissals and names of terminals the core no longer has. Only for machines
  // that answered: one that's offline leaves its terminals out of the list.
  forget(list) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(list.map((k) => machine(k.address)));
    const known = new Set(list.map((k) => k.address));
    const gone = (addr) => heard.has(machine(addr)) && !known.has(addr);
    const dismissed = [...this.dismissed].filter((a) => !gone(a));
    if (dismissed.length !== this.dismissed.size) {
      this.dismissed = new Set(dismissed);
      localStorage.setItem("dismissed", JSON.stringify(dismissed));
    }
    const progs = Object.keys(this.progs).filter(gone);
    for (const a of progs) delete this.progs[a];
    if (progs.length) localStorage.setItem("progs", JSON.stringify(this.progs));
  }

  // Keeps each running sub-agent's program and name, and notices one that ended.
  remember(all) {
    let changed = false;
    const kids = new Set();
    for (const k of all) {
      if (!k.parent || k.state !== "live") continue;
      kids.add(k.address);
      if (!k.program) continue;
      const name = k.name || k.template || k.program.name;
      const was = this.progs[k.address];
      if (was && was.n === name && was.p?.key === k.program.key) continue;
      this.progs[k.address] = { p: k.program, n: name };
      changed = true;
    }
    if (changed) localStorage.setItem("progs", JSON.stringify(this.progs));
    if (this.kids && [...this.kids].some((a) => !kids.has(a))) this.doneDirty = true;
    this.kids = kids;
  }

  // When each live sub-agent's state last changed (ms): stopping work stamps its end.
  // After a restart, the core's status_ms; the app doesn't keep that field current.
  stampKids(all, now) {
    const kidAt = {};
    for (const k of all) {
      if (!k.parent || k.state !== "live") continue;
      const s = kidStatus(k, this.listed);
      const was = this.kidAt?.[k.address];
      kidAt[k.address] = !was ? { s, at: k.status_ms ?? k.created_ms ?? now } : was.s !== s ? { s, at: now } : was;
    }
    this.kidAt = kidAt;
  }

  // Finished sub-agents of a listed agent and of its live sub-agents, as conversations:
  // a follow-up under the same name joins its first run. Newest end first; one with any
  // run not dismissed shows whole.
  threadsOf(addr, subs) {
    if (!showFinished()) return [];
    const owners = new Set([addr, ...subs.map((s) => s.t.address)]);
    const end = (th) => th.runs[th.runs.length - 1].finished_ms ?? 0;
    return groupThreads(this.done.filter((k) => owners.has(k.parent)))
      .filter((th) => th.runs.some((k) => !this.dismissed.has(k.address)))
      .sort((x, y) => end(y) - end(x));
  }

  dismiss(addrs) {
    for (const a of addrs) this.dismissed.add(a);
    localStorage.setItem("dismissed", JSON.stringify([...this.dismissed]));
  }

  // Tracks the row under the pointer, for controls shown only on hover.
  hoverable(el, id) {
    return el.on_hover((on, cx) => {
      if (on) this.hovered = id;
      else if (this.hovered === id) this.hovered = null;
      cx.notify();
    });
  }

  dismissButton(t, id, tip, addrs) {
    return div()
      .id(id)
      .flex_none()
      .ml(6)
      .p(2)
      .rounded(4)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.dismiss(addrs);
        this.hovered = null;
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/x.svg").size(12));
  }

  // The folded row under an agent: how many of its sub-agents finished, and how many
  // failed (the last round decides).
  doneHeader(t, a, threads, open) {
    const id = `done-${a.address}`;
    const failed = threads.filter((th) => ending(th.runs[th.runs.length - 1])?.bad).length;
    return this.hoverable(h_flex().id(id), id)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        open ? this.openDone.delete(a.address) : this.openDone.add(a.address);
        cx.notify();
      })
      .children(connectors(t, ["└"]))
      .child(h_flex().w(14).mr(8).flex_none().justify_center()
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${threads.length} finished`))
      .when(failed > 0, (el) => el.child(div().flex_none().ml(6).text_size(11).text_color(t.blocked).child(`${failed} failed`)))
      .when(this.hovered === id, (el) => el.child(this.dismissButton(t, `clear-${a.address}`, "Clear finished",
        threads.flatMap((th) => th.runs.map((k) => k.address)))));
  }

  nameOf(k) {
    const known = this.progs[k.address];
    return k.name || k.template || known?.n || (k.program ?? known?.p)?.name || k.address;
  }

  progOf(k) {
    return k.program ?? this.progs[k.address]?.p ?? null;
  }

  // What the conversation window gets: plain records, each with its program.
  slim(k) {
    const { address, name, template, argv, cwd, labels, parent, created_ms, finished_ms, exit_code, signal, reason } = k;
    return { address, name, template, argv, cwd, labels, parent, created_ms, finished_ms, exit_code, signal, reason, program: this.progOf(k) };
  }

  // Opens a conversation as big as a running sub-agent's peek.
  openThread(th, asker) {
    const last = th.runs[th.runs.length - 1];
    const thread = threadOf(th.runs);
    const live = terminals().filter((k) => k.state === "live" && belongs(thread, k));
    openOverlay({ mod: "agents", kind: "dialog", width: 0.8, height: 0.8, props: {
      thread: { ...thread, name: this.nameOf(last), program: this.progOf(last), asker },
      runs: th.runs.map((k) => this.slim(k)),
      live: live.map((k) => this.slim(k)),
    } });
  }

  // One finished conversation: dimmed, how its last round ended if not cleanly, and
  // since when; more than one round says how many. Names are unique only among running
  // terminals: a name two conversations share gets their end times.
  doneRow(t, th, lines, now, asker, repeated = false) {
    const k = th.runs[th.runs.length - 1];
    const id = `fin-${k.address}`;
    const pic = icon(this.progOf(k), 14, t.dim);
    const end = ending(k);
    const name = this.nameOf(k);
    const n = th.runs.length;
    return this.hoverable(h_flex().id(id), id)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .items_center()
      .text_size(12.5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(n > 1 ? `${n} rounds · last ${about(k)}` : about(k))
      .on_click(() => this.openThread(th, asker))
      .children(connectors(t, lines))
      .child(div().w(14).mr(8).flex_none().opacity(0.55).when(Boolean(pic), (el) => el.child(pic)))
      .child(div().min_w(0).truncate().text_color(t.dim).child(repeated && k.finished_ms != null ? `${name} · ${clock(k.finished_ms)}` : name))
      .when(n > 1, (el) => el.child(div().flex_none().ml(5).px(4).rounded(4).bg(t.hover).text_size(10).text_color(t.dim).child(String(n))))
      .child(div().flex_1())
      .when(Boolean(end), (el) => el.child(div().flex_none().ml(6).text_size(11).text_color(end.bad ? t.blocked : t.dim).child(end.text)))
      .child(this.hovered === id
        ? this.dismissButton(t, `x-${k.address}`, "Dismiss", th.runs.map((r) => r.address))
        : div().flex_none().ml(6).text_size(11).text_color(t.dim).child(k.finished_ms != null ? duration(now - k.finished_ms) : ""));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))))
      .child(div().mx(8).my(4).h(1).bg(t.border))
      .child(h_flex()
        .id("show-finished")
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.finished", !showFinished());
          closeOverlay(props().overlay);
        })
        .child(svg("mods/workspace-chrome/circle-check.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child("Finished sub-agents"))
        .when(showFinished(), (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  // `more`: a row follows the last one (the finished row), so its line goes on.
  tree(all, addr, lead = [], more = false) {
    // Newest end of work first: those still working (no end yet) on top, then the one
    // that stopped most recently. Finished ones follow in their own row, by when they ended.
    const at = (k) => this.kidAt?.[k.address]?.at ?? 0;
    const busy = (k) => (kidStatus(k, this.listed) === "working" ? 1 : 0);
    const kids = all.filter((k) => k.parent === addr && k.state === "live").sort((x, y) => busy(y) - busy(x) || at(y) - at(x));
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1 && !more;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(connectors(t, s.lines))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.thread) return conversationView(this, t);
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.remember(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.stampKids(all, now);
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      let subs = collapsed ? [] : this.tree(all, a.address);
      // Finished ones go last, in one folded row; the live tree's line runs on to it.
      const done = collapsed ? [] : this.threadsOf(a.address, subs);
      if (done.length) subs = this.tree(all, a.address, [], true);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      const rows = [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
      if (done.length) {
        const open = this.openDone.has(a.address);
        rows.push(this.doneHeader(t, a, done, open));
        // Who asked, as the conversation's request blocks say it: the agent, or a sub-agent.
        const askers = new Map([[a.address, a.program?.name || "Parent"], ...subs.map((s) => [s.t.address, this.nameOf(s.t)])]);
        const names = done.map((th) => this.nameOf(th.runs[th.runs.length - 1]));
        const repeated = (j) => names.indexOf(names[j]) !== names.lastIndexOf(names[j]);
        if (open) rows.push(...done.map((th, j) => this.doneRow(t, th, ["", j === done.length - 1 ? "└" : "├"], now,
          askers.get(th.runs[0].parent) ?? "Parent", repeated(j))));
      }
      return rows;
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agents", kind: "popup", width: 200, height: 180, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
