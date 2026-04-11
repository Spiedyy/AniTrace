export interface TikWMData {
  videoUrl: string;
  coverUrl: string;
  originCoverUrl: string | null;
  /** For photo slideshows: one URL per slide. Null for regular videos. */
  images: string[] | null;
  duration: number;
  title: string;
}

export async function fetchTikTokVideo(tiktokUrl: string): Promise<TikWMData> {
  const response = await fetch("https://www.tikwm.com/api/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url: tiktokUrl }),
  });

  if (!response.ok) {
    throw new Error(`TikWM request failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(data.msg || "TikWM API error");
  }

  const slideImages: string[] | null =
    Array.isArray(data.data.images) && data.data.images.length > 0
      ? data.data.images
      : null;

  return {
    videoUrl: data.data.play,
    coverUrl: data.data.cover,
    originCoverUrl: data.data.origin_cover ?? null,
    images: slideImages,
    duration: data.data.duration || 15,
    title: data.data.title || "",
  };
}
