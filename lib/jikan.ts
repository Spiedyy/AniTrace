const JIKAN_BASE_URL = "https://api.jikan.moe/v4";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JikanAnime = Record<string, any>;

/** Strip filename noise and trailing punctuation that hurts MAL search. */
export function cleanSearchTitle(title: string): string {
  return title
    .replace(/\.mkv|\.mp4/gi, "")
    .replace(/ - \d+$/, "")
    .replace(/[!?]+$/g, "")
    .trim();
}

async function jikanFetch(path: string, retries = 2): Promise<Response | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${JIKAN_BASE_URL}${path}`);
      // Retry transient MAL/Jikan outages and rate limits.
      if (response.status === 429 || response.status >= 500) {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        return null;
      }
      return response;
    } catch {
      if (attempt < retries) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function getAnimeById(malId: number): Promise<JikanAnime | null> {
  await sleep(350); // Respect 3 req/s rate limit
  const response = await jikanFetch(`/anime/${malId}/full`);
  if (!response?.ok) return null;
  try {
    const data = await response.json();
    return data.data ?? null;
  } catch {
    return null;
  }
}

export async function searchAnimeByTitle(title: string): Promise<JikanAnime | null> {
  await sleep(350);
  const cleanTitle = cleanSearchTitle(title);
  if (!cleanTitle) return null;

  const response = await jikanFetch(
    `/anime?q=${encodeURIComponent(cleanTitle)}&limit=5`
  );
  if (!response?.ok) return null;
  try {
    const data = await response.json();
    return data.data?.[0] ?? null;
  } catch {
    return null;
  }
}
