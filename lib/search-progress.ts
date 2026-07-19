/** Typical identify duration on Vercel (maxDuration is 60s). */
const ESTIMATED_MS = 45_000;
const TICK_MS = 250;

/** User-facing copy — not tied to backend steps. */
const LABEL_PHASES: { untilMs: number; label: string }[] = [
  { untilMs: 5_000, label: "Starting search…" },
  { untilMs: 18_000, label: "Analyzing the video…" },
  { untilMs: 32_000, label: "Looking for matches…" },
  { untilMs: ESTIMATED_MS, label: "Gathering details…" },
];

const LABEL_OVERTIME =
  "Still working — some videos take a bit longer…";

const LABEL_PAUSED = "Paused — switch back to this tab to continue…";
const LABEL_FINISHING = "Wrapping up…";

function labelForElapsed(elapsedMs: number): string {
  for (const phase of LABEL_PHASES) {
    if (elapsedMs < phase.untilMs) return phase.label;
  }
  return LABEL_OVERTIME;
}

/**
 * Time-based progress aligned to typical identify latency.
 * Reaches ~88% at ESTIMATED_MS, then creeps slowly so it never sits at "almost done" for long.
 */
export function progressForElapsed(elapsedMs: number): number {
  if (elapsedMs <= 0) return 2;

  const t = Math.min(1, elapsedMs / ESTIMATED_MS);
  const eased = 1 - (1 - t) ** 2.4;
  const withinEstimate = 2 + eased * 86;

  if (elapsedMs <= ESTIMATED_MS) {
    return Math.round(withinEstimate);
  }

  const overtimeSec = (elapsedMs - ESTIMATED_MS) / 1000;
  const creep = Math.min(9, overtimeSec * 0.35);
  return Math.round(88 + creep);
}

export function startSearchProgress(
  onUpdate: (progress: number, label: string) => void
): () => void {
  const startedAt = Date.now();

  const tick = () => {
    const elapsed = Date.now() - startedAt;
    onUpdate(progressForElapsed(elapsed), labelForElapsed(elapsed));
  };

  tick();
  const id = setInterval(tick, TICK_MS);
  return () => clearInterval(id);
}

export { LABEL_PAUSED, LABEL_FINISHING };
