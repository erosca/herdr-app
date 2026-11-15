// What check.py runs to draw the agents list's own rows (main.js) in Herdr's engine:
// an agent's row pieces with made-up sub-agents, done ones folded and unfolded. The
// engine reports only a thrown error, so a wrong element method or argument fails it.

import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import Agents from "./agents.js";
import { shownName } from "./util.js";

const now = Date.now();
const KIMI = { key: "kimi", name: "Kimi", icon: "icons/kimi.svg", tint: false };
const run = (n, more = {}) => ({ address: `vm/t${n}`, name: `kimi-review-of-terms-a7e8d${n % 10}`, parent: "vm/t1", state: "finished", exit_code: 0,
  reason: "exited", created_ms: now - 600000 * n, finished_ms: now - 500000 * n, labels: {}, program: KIMI, ...more });
const threads = Array.from({ length: 8 }, (_, n) => ({ runs: [run(n + 10, n === 2 ? { exit_code: 1 } : {})] }));
const agent = { address: "vm/t1", program: { key: "claude", name: "Claude Code" } };

export default class Sidebar extends View {
  init() {
    const a = Object.create(Agents.prototype);
    Object.assign(a, { progs: {}, dismissed: new Set(), openDone: new Set(), allDone: new Set(), hovered: null, listed: new Map(), kidAt: {} });
    this.a = a;
    const names = [shownName({ name: "codex-review-of-terms-a7e8d3" }), shownName({ name: "review-codex-5" }), shownName({ labels: { "herdr.title": "Kimi Java tutorial" }, name: "kimi-x-ab12cd" })];
    if (JSON.stringify(names) !== JSON.stringify(["review of terms", "review-codex-5", "Kimi Java tutorial"])) throw new Error(`names: ${JSON.stringify(names)}`);
  }

  render() {
    const t = theme();
    const a = this.a;
    const live = { t: { address: "vm/t2", name: "codex-java-tutorial-ab12cd", parent: "vm/t1", state: "live", status: "working", program: null }, lines: ["├"] };
    return v_flex().children([
      a.doneBadge(t, agent, threads, false),
      a.doneBadge(t, agent, threads, true),
      a.subRow(t, live, null, false, "Claude Code"),
      ...threads.slice(0, 5).map((th, j) => a.doneRow(t, th, ["├"], now, "Claude Code", j === 1)),
      a.doneFooter(t, agent, threads, false),
      a.doneFooter(t, agent, threads, true),
    ]);
  }
}
