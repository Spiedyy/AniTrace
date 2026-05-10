export interface TikWMData {
  videoUrl: string;
  /** HD quality URL — different CDN path, often works when `videoUrl` fails. */
  hdVideoUrl: string | null;
  /** Watermarked fallback URL — another CDN path to try if HD also fails. */
  wmVideoUrl: string | null;
  /**
   * TikWM-proxied video URL constructed from the video ID.
   * Unlike the direct TikTok CDN URLs (videoUrl / hdVideoUrl / wmVideoUrl),
   * this goes through tikwm.com's own servers and is NOT IP-restricted to
   * the machine that signed the CDN token.  Try this first.
   */
  tikwmProxyUrl: string;
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
    body: new URLSearchParams({ url: tiktokUrl, hd: "1" }),
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

  const videoId: string = data.data.id ?? "";

  return {
    videoUrl: data.data.play,
    hdVideoUrl: data.data.hdplay ?? null,
    wmVideoUrl: data.data.wmplay ?? null,
    // Stable proxy URL through tikwm.com — bypasses TikTok CDN IP restrictions
    tikwmProxyUrl: `https://www.tikwm.com/video/media/play/${videoId}.mp4`,
    coverUrl: data.data.cover,
    originCoverUrl: data.data.origin_cover ?? null,
    images: slideImages,
    duration: data.data.duration || 15,
    title: data.data.title || "",
  };
}
