const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

export interface AniListMedia {
  idMal: number | null;
  title: {
    romaji: string;
    english: string | null;
    native: string;
  };
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
