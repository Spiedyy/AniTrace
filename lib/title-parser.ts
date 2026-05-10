// Words that appear in TikTok call-to-action text but are not anime titles
const GENERIC_WORDS = new Set([
  "follow", "like", "share", "subscribe", "comment", "watch", "check",
  "more", "anime", "manga", "here", "new", "latest", "update", "recommended",
  "top", "best", "list", "ranking", "clip", "clips", "part", "episode",
  "fyp", "viral", "trending", "see", "and", "for", "the", "a", "an",
]);

const MONTH_NAMES =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/**
 * Extract likely anime title strings from a TikTok video description.
 *
 * Strategy:
 * 1. Strip hashtags
 * 2. Split on emoji characters (TikTok creators use them as section dividers)
 * 3. Filter out segments that are dates, call-to-action phrases, or too generic
 * 4. Return the surviving segments, trimmed
 *
 * Example input:
 *   "FOLLOW 4 MORE ANIME 👇 👉 Mistress Kanan is Devilishly Easy 📆 April 5, 2026 🟡 Kanan sama wa Akumade Choroi #anime #manga"
 *
 * Returns: ["Mistress Kanan is Devilishly Easy", "Kanan sama wa Akumade Choroi"]
 */
export function extractTitleCandidates(title: string): string[] {
  // Remove hashtags first
  const noHashtags = title.replace(/#\w+/g, "");

  // Split on emoji characters (common TikTok dividers like 👇👉📆🟡)
  const segments = noHashtags.split(
    /[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu
  );

  const candidates: string[] = [];

  for (const segment of segments) {
    // Remove leftover special chars, collapse whitespace
    const cleaned = segment.replace(/[^\w\s'\-]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;

    const words = cleaned.split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 10) continue;

    // Skip date segments (April 5, 2026)
    if (MONTH_NAMES.test(cleaned)) continue;
    if (/\b\d{4}\b/.test(cleaned)) continue;

    // Skip if the majority of significant words are call-to-action generics
    const significantWords = words.filter((w) => w.length > 2);
    if (significantWords.length === 0) continue;
    const genericCount = significantWords.filter((w) =>
      GENERIC_WORDS.has(w.toLowerCase())
    ).length;
    if (genericCount / significantWords.length > 0.5) continue;

    candidates.push(cleaned);
  }

  return candidates;
}
