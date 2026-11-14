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

// The tooltip of a finished sub-agent: how it ended, how long it ran, when.
export function about(k) {
  const how = ending(k)?.text ?? (k.exit_code === 0 ? "exit 0" : k.reason || "finished");
  const ran = k.finished_ms != null && k.created_ms != null ? ` · ran ${span(k.finished_ms - k.created_ms)}` : "";
  return `${how}${ran}${k.finished_ms != null ? ` · ended ${clock(k.finished_ms)}` : ""}`;
}
