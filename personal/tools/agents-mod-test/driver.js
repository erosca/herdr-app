// What check.py runs in place of the agents mod's main.js, through `herdr-app check`:
// the mod's own thread.js and conversation.js in Herdr's engine. The engine runs one
// init and one render, nothing asynchronous, and reports only a thrown error, so:
//   - the mod's steps (thread.js) are replayed against the answers check.py recorded;
//     a request with no answer yet stops the case and is thrown as NEED, for check.py
//     to run and ask again;
//   - MODE "report" throws what each case came to, for check.py to compare;
//   - MODE "view" renders one case's conversation window for real: a wrong element
//     method or argument fails the check;
//   - MODE "watch" renders the bar over a running sub-agent's live terminal, with the
//     request WATCH (null: none was recorded).

import { View } from "gpui-kit";
import { theme } from "herdr";
import * as thread from "./thread.js";
import { initConversation, conversationView } from "./conversation.js";
import { initWatch, watchView } from "./watch.js";
import { CASES, ANSWERS, MODE, VIEW, OPEN, WATCH } from "./cases.js";

const NEED = {};

function replay(steps, needs, asked) {
  let r = steps.next();
  while (!r.done) {
    asked.push(r.value);
    const a = ANSWERS[JSON.stringify(r.value)];
    if (!a) {
      needs.push(r.value);
      throw NEED;
    }
    r = "error" in a ? steps.throw(new Error(a.error)) : steps.next(a.value);
  }
  return r.value;
}

// A long text as its length: real conversations stay out of the report.
const brief = (s) => (typeof s === "string" && s.length > 60 ? { chars: s.length } : s);

function told(c, rounds) {
  return rounds.map((r) => {
    const { run, transcript, ...rest } = r;
    const out = { ...rest, address: run?.address ?? null, transcript: c.brief ? brief(transcript) : transcript };
    if (!c.brief) return out;
    const kinds = {};
    for (const s of r.work) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    return { ...out, request: brief(r.request), answer: brief(r.answer), work: { kinds, failed: r.work.filter((s) => s.error).length, timed: r.work.filter((s) => s.ms != null).length } };
  });
}

// A run still going is looked at `c.looks` times, each look reading on from the last
// (check.py lets its log grow in between): every look's rounds, the last one last.
function looks(k, c, needs, asked) {
  const all = [];
  let state = null;
  for (let n = 0; n < (c.looks ?? 1); n++) {
    const got = replay(thread.liveSteps(k, state), needs, asked);
    state = got.state;
    all.push(got.rounds);
  }
  return all;
}

function run(c, needs) {
  if (c.call) return { name: c.name, result: thread[c.call](...c.args) };
  const asked = [];
  // What was asked of the app, without the scripts: which kind, of which machine.
  const place = (q) => (q[0] === "hc" ? `hc ${q[1][0]} ${q[1][1]}` : q[0] === "sh" ? `sh ${q[3] ?? "here"} ${q[2][0]}` : `file ${q[2] ?? "here"} ${q[1]}`);
  try {
    // What a running one was asked, as the bar over its terminal looks it up.
    if (c.ask) return { name: c.name, report: { name: c.name, result: replay(thread.requestSteps(c.ask), needs, asked), asked: asked.map(place) } };
    const live = (c.live ?? []).map((k) => looks(k, c, needs, asked));
    const lists = [
      ...(c.runs ?? []).map((k) => replay(thread.roundsSteps(k), needs, asked)),
      ...live.map((all) => all[all.length - 1]),
    ];
    const rounds = thread.inOrder(lists);
    const where = asked.map(place);
    // Each look at the first running one: what its last round had by then.
    const seen = (live[0] ?? []).map((rs) => {
      const r = rs[rs.length - 1];
      return { steps: r.work.map((s) => `${s.kind} ${c.brief ? "" : s.text}`.trim()), answer: c.brief ? brief(r.answer) : r.answer, done: r.done ?? null, live: r.live };
    });
    return { name: c.name, rounds, report: { name: c.name, asked: where, rounds: told(c, rounds), looks: seen } };
  } catch (e) {
    if (e === NEED) return { name: c.name, pending: true };
    return { name: c.name, report: { name: c.name, error: String(e?.stack ?? e) } };
  }
}

export default class Driver extends View {
  init(_props, cx) {
    this.needs = [];
    this.done = CASES.map((c) => run(c, this.needs));
    if (MODE === "watch") {
      const c = CASES[VIEW];
      return initWatch(this, cx, { watch: { thread: c.thread, runs: c.runs ?? [], live: (c.live ?? c.runs)[0] }, request: WATCH, overlay: "check" });
    }
    if (MODE !== "view" || this.needs.length) return;
    const c = CASES[VIEW];
    const rounds = this.done[VIEW].rounds;
    initConversation(this, cx, { thread: c.thread, runs: c.runs ?? [], live: c.live ?? [], rounds, overlay: "check" });
    if (OPEN == null) return;
    // One round open with everything in it unfolded: its whole request, its steps (each
    // to its whole text), its terminal output.
    this.open = rounds[OPEN].key;
    for (const r of rounds) {
      this.full.add(r.key);
      this.work.add(r.key);
      if (r.transcript) this.term.add(r.key);
      (r.work ?? []).forEach((_, j) => this.steps.add(`${r.key}-${j}`));
    }
  }

  render() {
    if (MODE === "watch") return watchView(this, theme());
    if (this.needs.length) throw new Error(`NEED ${JSON.stringify(this.needs)}`);
    if (MODE === "report") throw new Error(`REPORT ${JSON.stringify(this.done.map((d) => d.report ?? { name: d.name, result: d.result }))}`);
    return conversationView(this, theme());
  }
}
