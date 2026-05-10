export interface TikComment {
  id: string;
  text: string;
  likes: number;
  replyCount: number;
}

export interface TikCommentCandidate {
  text: string;
  likes: number;
  fromNamePattern: boolean;
}

/** Fetch top-level comments for a TikTok video via TikWM. */
export async function fetchComments(tiktokUrl: string, count = 50): Promise<TikComment[]> {
  try {
    const response = await fetch("https://www.tikwm.com/api/comment/list", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: tiktokUrl, count: String(count), cursor: "0" }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (data.code !== 0 || !Array.isArray(data.data?.comments)) return [];
    return data.data.comments.map((c: {
      cid?: string; id?: string;
      text: string; digg_count: number; reply_comment_total?: number;
    }) => ({
      id: String(c.cid ?? c.id ?? ""),
      text: String(c.text ?? "").trim(),
      likes: Number(c.digg_count ?? 0),
      replyCount: Number(c.reply_comment_total ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Fetch replies for a specific comment via TikWM. */
export async function fetchCommentReplies(tiktokUrl: string, commentId: string, count = 30): Promise<TikComment[]> {
  if (!commentId) return [];
  try {
    const response = await fetch("https://www.tikwm.com/api/comment/reply/list", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: tiktokUrl, comment_id: commentId, count: String(count), cursor: "0" }),
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (data.code !== 0 || !Array.isArray(data.data?.comments)) return [];
    return data.data.comments.map((c: {
      cid?: string; id?: string;
      text: string; digg_count: number;
    }) => ({
      id: String(c.cid ?? c.id ?? ""),
      text: String(c.text ?? "").trim(),
      likes: Number(c.digg_count ?? 0),
      replyCount: 0,
    }));
  } catch {
    return [];
  }
}

// ── Name-pattern extraction ──────────────────────────────────────────────────

// "name: Attack on Titan", "anime name: ...", "name - ...", "name : ..."
const NAME_ANSWER_RE = /(?:^|[\s,])(?:anime\s+)?name\s*[:\-]\s*(.{2,60})/i;

// Broad name-question detector — no "?" required.
// Matches: "name?", "anime name please", "name pls", "what's the name",
//          "what is the anime name", "name please", "anime name?"
const NAME_QUESTION_RE =
  /(?:(?:^|\s)(?:anime\s+)?name(?:\s+(?:please|pls)|\s*\?+)(?:\s|$))|(?:what(?:'?s)?\s+(?:is\s+)?(?:the\s+)?(?:anime\s+)?name)/i;

/** Extract anime title from a "name: [title]" style comment. Returns null if no match. */
function extractNameAnswer(text: string): string | null {
  const match = text.match(NAME_ANSWER_RE);
  if (!match) return null;
  const raw = match[1]
    .split(/[,!\n?]/)[0]
    .replace(/[^\w\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = raw.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 8) return null;
  return raw || null;
}

/** Returns true if this comment is asking for the anime name (answer is in replies). */
export function isNameQuestion(text: string): boolean {
  return NAME_QUESTION_RE.test(text);
}

/**
 * Scan a list of comments for explicit "name: [title]" answers.
 * These bypass the normal heuristic filters — the label is a strong signal.
 */
export function extractNameCandidates(comments: TikComment[]): TikCommentCandidate[] {
  const seen = new Set<string>();
  const results: TikCommentCandidate[] = [];

  for (const { text, likes } of comments) {
    const title = extractNameAnswer(text);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ text: title, likes, fromNamePattern: true });
  }

  // Sort by likes descending
  return results.sort((a, b) => b.likes - a.likes);
}

// ── Direct reply extraction (replies to name-question comments) ─────────────

const REACTION_WORDS = new Set([
  "lol", "lmao", "lmfao", "omg", "wtf", "fr", "ngl", "same",
  "yes", "no", "yep", "nope", "yeah", "nah", "ok", "okay",
  "true", "facts", "real", "cry", "bro", "bruh", "man", "dude",
  "damn", "fire", "mid", "goat", "based", "sad", "nice",
  "thanks", "ty", "thx", "np", "facts", "cap",
]);

/**
 * Extract reply candidates when the parent comment asked for the anime name.
 * Unlike extractNameCandidates, this does NOT require a "name: [title]" prefix
 * and does NOT enforce a likes threshold — the reply context itself is the signal.
 * e.g. "kill blue" with 0 likes → valid candidate, fromNamePattern: true.
 */
export function extractDirectReplyCandidates(replies: TikComment[]): TikCommentCandidate[] {
  const seen = new Set<string>();
  const results: TikCommentCandidate[] = [];

  const sorted = [...replies].sort((a, b) => b.likes - a.likes);

  for (const { text, likes } of sorted) {
    const cleaned = text
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[^\w\s'\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) continue;

    // First check for explicit "name: [title]" pattern and use that if present
    const nameMatch = cleaned.match(/(?:^|[\s,])(?:anime\s+)?name\s*[:\-]\s*(.{2,60})/i);
    if (nameMatch) {
      const raw = nameMatch[1].split(/[,!\n?]/)[0].replace(/[^\w\s'\-]/g, " ").replace(/\s+/g, " ").trim();
      const words = raw.split(" ").filter(Boolean);
      if (words.length >= 1 && words.length <= 8) {
        const key = raw.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ text: raw, likes, fromNamePattern: true });
        }
        continue;
      }
    }

    const words = cleaned.split(" ").filter(Boolean);
    // Replies that are 1–6 words could be a title; longer are usually sentences
    if (words.length < 1 || words.length > 6) continue;

    const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, "");

    // Skip single-word reactions and filler
    if (words.length === 1 && REACTION_WORDS.has(firstWord)) continue;

    // Skip replies that themselves look like questions or filler openers
    if (SKIP_FIRST_WORDS.has(firstWord)) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ text: cleaned, likes, fromNamePattern: true });
  }

  return results;
}

// ── Heuristic extraction (fallback) ─────────────────────────────────────────

const SKIP_FIRST_WORDS = new Set([
  "why", "what", "how", "who", "when", "where", "which", "whose",
  "did", "do", "does", "is", "are", "was", "were", "can", "could",
  "would", "should", "will", "have", "has", "had",
  "i", "im", "ive", "id", "ill", "he", "she", "they", "we", "you",
  "this", "that", "it", "the", "a", "an",
  "lol", "lmao", "lmfao", "bro", "bruh", "omg", "wtf", "tf", "fr",
  "ngl", "same", "wait", "man", "dude", "not", "no", "yes",
  "ok", "okay", "so", "literally", "actually", "imagine",
  "and", "but", "or", "if", "then", "because", "when", "since",
  "name", // avoid "name" as a standalone candidate
]);

const GENERIC_ANIME_WORDS = new Set([
  "anime", "romance", "manga", "waifu", "kawaii", "oppai",
  "isekai", "shonen", "shounen", "harem", "ecchi", "moe",
]);

/**
 * Heuristic extraction — returns at most 5 candidates sorted by likes.
 * Used as fallback when no name-pattern comments are found.
 */
export function extractCandidatesFromComments(comments: TikComment[]): TikCommentCandidate[] {
  const seen = new Set<string>();
  const candidates: TikCommentCandidate[] = [];

  const sorted = [...comments].sort((a, b) => b.likes - a.likes);

  for (const { text, likes } of sorted) {
    if (likes < 5) continue;

    const cleaned = text
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[^\w\s'\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const words = cleaned.split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 7) continue;

    const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, "");
    if (SKIP_FIRST_WORDS.has(firstWord)) continue;

    if (words.some((w) => GENERIC_ANIME_WORDS.has(w.toLowerCase()))) continue;
    if (words.some((w) => /^\d+$/.test(w) && parseInt(w) > 10)) continue;

    const normalised = cleaned.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);

    candidates.push({ text: cleaned, likes, fromNamePattern: false });
    if (candidates.length >= 5) break;
  }

  return candidates;
}
