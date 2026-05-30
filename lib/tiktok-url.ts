/** Full-string validation for pasted URLs in the search bar. */
export const TIKTOK_URL_REGEX = /^https?:\/\/(www\.|vm\.|m\.)?tiktok\.com\/.+/i;

/** Find a TikTok URL inside shared text (caption + link, etc.). */
const TIKTOK_URL_IN_TEXT_REGEX =
  /https?:\/\/(?:www\.|vm\.|m\.)?tiktok\.com\/[^\s]+/i;

export function extractTikTokUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (TIKTOK_URL_REGEX.test(trimmed)) return trimmed;

  const match = trimmed.match(TIKTOK_URL_IN_TEXT_REGEX);
  if (!match) return null;

  return match[0].replace(/[.,!?)\]]+$/, "");
}

/** Web Share Target / Shortcut opens with ?url=, ?text=, or ?title=. */
export function parseSharedTikTokUrl(params: URLSearchParams): string | null {
  for (const key of ["url", "text", "title"] as const) {
    const raw = params.get(key);
    if (!raw) continue;
    const found = extractTikTokUrl(raw);
    if (found) return found;
  }
  return null;
}
