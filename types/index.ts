export interface TikWMResponse {
  code: number;
  msg: string;
  data: {
    id: string;
    title: string;
    play: string;
    cover: string;
    duration: number;
    music: string;
  };
}

export interface TraceMoeResult {
  anilist: number;
  filename: string;
  episode: number | string | null;
  from: number;
  to: number;
  similarity: number;
  video: string;
  image: string;
}

export interface TraceMoeResponse {
  frameCount: number;
  error: string;
  result: TraceMoeResult[];
}

export interface AnimeResult {
  malId: number;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  imageUrl: string;
  synopsis: string;
  score: number;
  episodes: number | null;
  status: string;
  rating: string;
  season: string | null;
  year: number | null;
  genres: string[];
  studios: string[];
  malUrl: string;
  trailerUrl: string | null;
  similarity: number;
  matchedEpisode: number | string | null;
}

export interface IdentifyResponse {
  success: boolean;
  results: AnimeResult[];
  error?: string;
  /** Base64 data URIs of every image sent to trace.moe — only in development */
  debugImages?: string[];
}
