const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

export interface AniListMedia {
  idMal: number | null;
  title: {
    romaji: string;
    english: string | null;
    native: string;
  };
  coverImage?: { large: string | null } | null;
  description?: string | null;
  episodes?: number | null;
  status?: string | null;
  averageScore?: number | null;
  season?: string | null;
  seasonYear?: number | null;
  genres?: string[] | null;
  studios?: { nodes: { name: string }[] } | null;
}

export async function getMediaByAnilistId(anilistId: number): Promise<AniListMedia | null> {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        idMal
        title { romaji english native }
      }
    }
  `;

  try {
    const response = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id: anilistId } }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.Media ?? null;
  } catch {
    return null;
  }
}

/** Search AniList by title — used when Jikan/MAL is down or returns nothing. */
export async function searchMediaByTitle(title: string): Promise<AniListMedia | null> {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        idMal
        title { romaji english native }
        coverImage { large }
        description
        episodes
        status
        averageScore
        season
        seasonYear
        genres
        studios { nodes { name } }
      }
    }
  `;

  try {
    const response = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { search: title } }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.Media ?? null;
  } catch {
    return null;
  }
}
