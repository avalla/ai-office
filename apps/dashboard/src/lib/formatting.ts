import { formatDuration, formatTimestamp, shortId } from "../ui/view-model.ts";
export { formatDuration, formatTimestamp, shortId };
export function elapsed(
  start: string | null,
  end: string | null = null,
  now = Date.now(),
): string {
  if (start === null) return "—";
  const from = new Date(start).getTime();
  const until = end === null ? now : new Date(end).getTime();
  return Number.isFinite(from) && Number.isFinite(until)
    ? formatDuration(Math.max(0, until - from))
    : "—";
}
