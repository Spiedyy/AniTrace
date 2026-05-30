/** Track whether the tab was backgrounded during an in-flight task. */
export function trackHiddenDuringTask(): {
  wasHidden: () => boolean;
  cleanup: () => void;
} {
  let hidden = document.hidden;

  const onVisibility = () => {
    if (document.hidden) hidden = true;
  };

  document.addEventListener("visibilitychange", onVisibility);

  return {
    wasHidden: () => hidden,
    cleanup: () => document.removeEventListener("visibilitychange", onVisibility),
  };
}

export interface InterruptedSearch {
  url: string;
  excludeIds: number[];
}

/** Fetch failures that commonly happen when Safari/Chrome suspend a background tab. */
export function isLikelyBackgroundFetchFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return false;
}
