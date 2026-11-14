// Helpers the agents list and the conversation window share.

import { image, svg } from "gpui-kit";

// The agent's icon from the app's program table: a one-color glyph or a picture.
export function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// How a finished sub-agent ended, when that's worth a word: a clean exit says nothing.
export function ending(k) {
  if (k.reason === "killed") return { text: "stopped", bad: false };
  if (k.exit_code != null && k.exit_code !== 0) return { text: `exit ${k.exit_code}`, bad: true };
  if (k.signal != null) return { text: `signal ${k.signal}`, bad: true };
  if (k.exit_code == null && k.reason && k.reason !== "exited") return { text: "lost", bad: true };
  return null;
}

export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The windows a sub-agent opens as, as openOverlay takes them. Both are as big as a peek.
const BIG = { kind: "dialog", width: 0.8, height: 0.8 };

/** Its conversation: each round's request, work and answer. `find`: the conversation's
 * finished runs are asked of the core first (the opener's list may lack the newest). */
export const conversationOf = (thread, runs, live, find = false) => ({ mod: "agents", ...BIG, props: { thread, runs, live, find } });

// How tall the bar over a watched terminal is: its header, and its request's first lines.
export const WATCH_HEAD = 168;

/** A running one's live terminal, under a bar with the request it was sent (watch.js). */
export const watchOf = (thread, runs, k) => ({ ...BIG, layout: { type: "column", children: [
  { type: "block", size: { px: WATCH_HEAD }, content: { mod: "agents", props: { watch: { thread, runs, live: k } } } },
  { type: "block", content: { terminal: k.address } },
] } });
