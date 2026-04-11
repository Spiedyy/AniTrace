const JIKAN_BASE_URL = "https://api.jikan.moe/v4";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JikanAnime = Record<string, any>;

export async function getAnimeById(malId: number): Promise<JikanAnime | null> {
  await sleep(350); // Respect 3 req/s rate limit
  try {
    const response = await fetch(`${JIKAN_BASE_URL}/anime/${malId}/full`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.data ?? null;
  } catch {
    return null;
  }
}

export async function searchAnimeByTitle(title: string): Promise<JikanAnime | null> {
  await sleep(350);
  const cleanTitle = title
    .replace(/\.mkv|\.mp4/gi, "")
    .replace(/ - \d+$/, "")
    .trim();
  try {
    const response = await fetch(
      `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(cleanTitle)}&limit=5`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.[0] ?? null;
  } catch {
    return null;
  }
}
