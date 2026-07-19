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
export async function fetchCommentReplies(
  tiktokUrl: string,
  commentId: string,
  count = 30
): Promise<TikComment[]> {
  if (!commentId) return [];
  try {
    const response = await fetch("https://www.tikwm.com/api/comment/reply/list", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        url: tiktokUrl,
        comment_id: commentId,
        count: String(count),
        cursor: "0",
      }),
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

function normalizeCommentText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .trim();
}

// "name: Attack on Titan", "anime title - ...", "sauce: ..."
const NAME_ANSWER_RE =
  /(?:^|[\s,])(?:(?:anime\s+)?(?:name|title|tittle|titel)|sauce|source)\s*[:\-]\s*(.{2,80})/i;

// Name / sauce / title questions — answer is usually in the replies.
// Covers: "name?", "sauce?", "anime name please", "Name of the Anime Please?",
//         "what's the name", "what anime is this", "drop the sauce", etc.
const NAME_QUESTION_RE =
  /(?:^|[\s.,!?])(?:anime\s+)?(?:name|title|tittle|titel|sauce|source)(?:\s+(?:please|pls|plz)|\s*\?+)(?:\s|$|[!?])|(?:name|title|tittle|titel)\s+of\s+(?:the\s+|this\s+|that\s+)?(?:anime|show|series)|(?:what(?:'?s|s)?\s+(?:is\s+)?(?:the\s+)?(?:anime\s+)?(?:name|title|tittle|titel|sauce|source))|(?:(?:what|which)\s+anime)|(?:^|\s)sauce\s*\??|(?:(?:drop|got|need)\s+(?:the\s+)?sauce)|(?:anyone\s+know\s+(?:the\s+)?(?:name|anime|title|tittle|titel|sauce))|(?:what(?:'?s|s)?\s+this\s+(?:from|anime))|(?:^(?:anime\s+)?(?:name|title|tittle|titel|sauce|source)\s*$)/i;

const AUDIO_QUESTION_RE = /\b(song|bgm|music|sound|audio|background\s+song)\b/i;
const ANIME_CONTEXT_RE = /\b(anime|show|series|character|manga)\b/i;

const REACTION_WORDS = new Set([
  "lol", "lmao", "lmfao", "omg", "wtf", "fr", "ngl", "same",
  "yes", "no", "yep", "nope", "yeah", "nah", "ok", "okay",
  "true", "facts", "real", "cry", "bro", "bruh", "man", "dude",
  "damn", "fire", "mid", "goat", "based", "sad", "nice",
  "thanks", "ty", "thx", "np", "cap", "slay", "period",
]);

/** Adjectives / filler that appear in reaction replies, not anime titles. */
const GENERIC_TITLE_WORDS = new Set([
  "cute", "pretty", "hot", "sexy", "beautiful", "gorgeous", "handsome",
  "funny", "hilarious", "sad", "tragic", "crazy", "insane", "wild",
  "good", "great", "best", "worst", "bad", "fire", "mid", "goat",
  "real", "true", "facts", "based", "valid", "iconic", "legendary",
  "perfect", "amazing", "awesome", "cool", "lit", "slay", "period",
  "she", "he", "her", "him", "they", "this", "that", "girl", "boy",
  "woman", "man", "dude", "bro", "sis", "queen", "king",
]);

const SKIP_FIRST_WORDS = new Set([
  "why", "what", "how", "who", "when", "where", "which", "whose",
  "did", "do", "does", "is", "are", "was", "were", "can", "could",
  "would", "should", "will", "have", "has", "had",
  "i", "im", "ive", "id", "ill", "he", "she", "they", "we", "you",
  "this", "that", "it", "the", "a", "an",
  "lol", "lmao", "lmfao", "bro", "bruh", "omg", "wtf", "tf", "fr",
  "ngl", "same", "wait", "man", "dude", "not", "no", "yes",
  "ok", "okay", "so", "too", "very", "really", "super", "such",
  "literally", "actually", "imagine",
  "and", "but", "or", "if", "then", "because", "when", "since",
  "name", "him", "her", "me", "my", "give", "pass", "blame",
]);

/** Reject reaction phrases that look like titles but aren't ("so cute", "too funny"). */
export function isPlausibleAnimeTitle(text: string): boolean {
  const cleaned = normalizeCommentText(text)
    .replace(/[^\w\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return false;

  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 10) return false;

  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const significant = lower.filter((w) => w.length > 2);
  if (significant.length === 0) return false;

  // Entire phrase is reaction filler: "so cute", "too good", "very pretty"
  if (significant.every((w) => GENERIC_TITLE_WORDS.has(w) || REACTION_WORDS.has(w))) {
    return false;
  }

  // Leading intensifier + only generic words: "so cute", "really hot"
  if (
    words.length <= 3 &&
    SKIP_FIRST_WORDS.has(lower[0]) &&
    significant.every((w) => GENERIC_TITLE_WORDS.has(w) || w === lower[0])
  ) {
    return false;
  }

  return true;
}

/** Clean a raw title string extracted from a comment/reply. */
function cleanTitleCandidate(raw: string, maxWords = 10): string | null {
  const cleaned = normalizeCommentText(raw)
    .split(/[,!\n?]/)[0]
    .replace(/[^\w\s'\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.split(" ").filter(Boolean).length > maxWords) return null;
  if (!isPlausibleAnimeTitle(cleaned)) return null;
  return cleaned;
}

/** Extract anime title from a "name: [title]" / "sauce: [title]" style comment. */
function extractNameAnswer(text: string): string | null {
  const match = text.match(NAME_ANSWER_RE);
  if (!match) return null;
  return cleanTitleCandidate(match[1]);
}

/**
 * Extract "it's X" / "this is X" / "called X" style answers common in replies.
 */
function extractItsTitle(text: string): string | null {
  const match = normalizeCommentText(text).match(
    /(?:^|[\s,])(?:it'?s|its|this\s+is|that'?s|thats|called|named)\s+(.{2,50})$/i
  );
  if (!match) return null;
  return cleanTitleCandidate(match[1]);
}

/** Extract quoted title text: "Akame ga Kill!" */
function extractQuotedTitle(text: string): string | null {
  const normalized = normalizeCommentText(text);
  const match = normalized.match(/["]([^"]{2,100})["]/);
  if (!match) return null;
  return cleanTitleCandidate(match[1], 14);
}

/** Returns true if this comment is asking for the anime name (answer is in replies). */
export function isNameQuestion(text: string): boolean {
  const normalized = normalizeCommentText(text.toLowerCase());
  if (AUDIO_QUESTION_RE.test(normalized) && !ANIME_CONTEXT_RE.test(normalized)) {
    return false;
  }
  return NAME_QUESTION_RE.test(normalized);
}

/**
 * Scan a list of comments for explicit "name: [title]" / "sauce: [title]" answers.
 */
export function extractNameCandidates(comments: TikComment[]): TikCommentCandidate[] {
  const seen = new Set<string>();
  const results: TikCommentCandidate[] = [];

  for (const { text, likes } of comments) {
    const title = extractNameAnswer(text) ?? extractItsTitle(text) ?? extractQuotedTitle(text);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ text: title, likes, fromNamePattern: true });
  }

  return results.sort((a, b) => b.likes - a.likes);
}

// ── Direct reply extraction ─────────────────────────────────────────────────

/**
 * Extract title candidates from replies under a name-question (or high-reply) parent.
 * Plain short replies like "kill blue" count — the reply context is the signal.
 */
export function extractDirectReplyCandidates(replies: TikComment[]): TikCommentCandidate[] {
  const seen = new Set<string>();
  const results: TikCommentCandidate[] = [];

  const sorted = [...replies].sort((a, b) => b.likes - a.likes);

  for (const { text, likes } of sorted) {
    const named = extractNameAnswer(text) ?? extractItsTitle(text) ?? extractQuotedTitle(text);
    if (named) {
      const key = named.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ text: named, likes, fromNamePattern: true });
      }
      continue;
    }

    const cleaned = text
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
      .replace(/[^\w\s'\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned || !isPlausibleAnimeTitle(cleaned)) continue;

    const words = cleaned.split(" ").filter(Boolean);
    // Replies that are 1–6 words could be a title; longer are usually sentences
    if (words.length < 1 || words.length > 6) continue;

    const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, "");

    if (words.length === 1 && REACTION_WORDS.has(firstWord)) continue;
    if (SKIP_FIRST_WORDS.has(firstWord)) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ text: cleaned, likes, fromNamePattern: true });
  }

  return results;
}

// ── Which parents to fetch replies for ──────────────────────────────────────

/**
 * Pick parent comments whose replies are most likely to contain the anime title.
 * Priority: explicit name/sauce questions → then highest reply-count threads.
 */
export function selectCommentsForReplyFetch(
  comments: TikComment[],
  maxFetches = 6
): TikComment[] {
  const withReplies = comments.filter((c) => c.replyCount > 0 && c.id);
  if (withReplies.length === 0) return [];

  const questions = withReplies
    .filter((c) => isNameQuestion(c.text))
    .sort((a, b) => b.replyCount - a.replyCount || b.likes - a.likes);

  const picked = new Set<string>();
  const out: TikComment[] = [];

  for (const c of questions) {
    if (out.length >= maxFetches) break;
    if (picked.has(c.id)) continue;
    picked.add(c.id);
    out.push(c);
  }

  // Also dig into popular threads — answers often live under viral comments,
  // not only under "name?" questions.
  const byReplies = [...withReplies].sort(
    (a, b) => b.replyCount - a.replyCount || b.likes - a.likes
  );
  for (const c of byReplies) {
    if (out.length >= maxFetches) break;
    if (picked.has(c.id)) continue;
    // Skip threads with only 1 reply unless it's a question (already added).
    if (c.replyCount < 2 && !isNameQuestion(c.text)) continue;
    picked.add(c.id);
    out.push(c);
  }

  return out;
}

/**
 * Fetch replies for selected parents and extract title candidates.
 * Runs reply fetches in parallel (bounded by selectCommentsForReplyFetch).
 */
export async function collectReplyCandidates(
  tiktokUrl: string,
  comments: TikComment[],
  maxFetches = 6
): Promise<TikCommentCandidate[]> {
  const parents = selectCommentsForReplyFetch(comments, maxFetches);
  if (parents.length === 0) return [];

  const batches = await Promise.all(
    parents.map(async (parent) => {
      const replies = await fetchCommentReplies(tiktokUrl, parent.id);
      const found = extractDirectReplyCandidates(replies);
      if (found.length > 0) {
        console.log(
          `[comments] Reply answers under "${parent.text.slice(0, 40)}" ` +
          `(${parent.replyCount} replies):`,
          found.map((c) => c.text)
        );
      }
      // Boost likes by parent popularity so viral reply threads sort higher.
      return found.map((c) => ({
        ...c,
        likes: c.likes + Math.min(parent.likes, 500),
        fromNamePattern: true as const,
      }));
    })
  );

  const seen = new Set<string>();
  const merged: TikCommentCandidate[] = [];
  for (const c of batches.flat().sort((a, b) => b.likes - a.likes)) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  return merged;
}

// ── Heuristic extraction (fallback) ─────────────────────────────────────────

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
