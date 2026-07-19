import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AIAnimeMatch {
  title: string;
  alternativeTitles: string[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const SLIDE_TEXT_PROMPT = `You are reading text from a TikTok photo slide about anime.
Your only task: extract any anime series titles that are WRITTEN AS TEXT on this image.

Respond ONLY with a JSON array of strings (no markdown, no explanation):
["Title found on image", "Another title"]

Rules:
- Only return text you can actually see written on the image
- Include both romaji and English if both appear
- Ignore generic words: "anime", "episode", "part", "watch", etc.
- If no anime title text is visible, return: []`;

/**
 * Reads anime title text that is visually printed/overlaid on a slide image.
 * Returns an array of candidate title strings (may be empty).
 * Does NOT guess from visual content — only reads visible text.
 */
export async function readAnimeNamesFromSlide(base64Image: string): Promise<string[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  const base64Data = base64Image.replace(/^data:image\/[^;]+;base64,/, "");
  const mimeType = base64Image.startsWith("data:image/png") ? "image/png"
    : base64Image.startsWith("data:image/webp") ? "image/webp"
    : "image/jpeg";
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg", data: base64Data } },
          { type: "text", text: SLIDE_TEXT_PROMPT },
        ],
      }],
    });
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((s: unknown) => typeof s === "string" && s.length > 1) : [];
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT = `You are an expert anime identifier. Given screenshots from a TikTok video, identify which anime series is being shown.

Respond ONLY with a JSON object in this exact format (no markdown, no explanation outside the JSON):
{
  "title": "Official romanized title of the anime",
  "alternativeTitles": ["Alternative title 1", "Alternative title 2"],
  "confidence": "high" | "medium" | "low",
  "reasoning": "Brief explanation of visual clues you used"
}

Guidelines:
- "title" should be the most commonly known romanized title (e.g. "Attack on Titan" not "Shingeki no Kyojin")
- Include both romaji and English titles in "alternativeTitles" if different from "title"
- "confidence": "high" = very distinctive art style/characters, "medium" = likely but uncertain, "low" = guessing
- If genuinely unidentifiable, set title to "" and confidence to "low"
- Focus on: art style, character designs, color palette, setting, distinctive visual elements
- Many TikToks are reaction/commentary videos: the creator may talk first, then show anime in a SMALL INSET or picture-in-picture box. Look carefully at corner insets and any small anime footage — ignore the person's face/webcam
- Frames may be cropped to focus on inset regions — prioritize anime content over overlays
- Ignore TikTok text overlays, usernames, and captions
- When TikTok hashtags are provided, treat them as strong hints: creators often write anime titles without spaces (e.g. "#akamegakil" → "Akame ga Kill", "#esdeath" → character from that series). Prefer a title that fits both the visuals AND the hashtags when they agree`;

export interface IdentifyAnimeOptions {
  /** Non-generic TikTok hashtags (e.g. "akamegakil") — often the title without spaces. */
  hashtags?: string[];
}

/**
 * Uses Claude's vision capability to identify anime from extracted video frames.
 * Accepts up to 8 base64-encoded JPEG frames (data:image/jpeg;base64,...).
 * Returns null if the API key is missing or the call fails.
 */
export async function identifyAnimeFromImages(
  base64Images: string[],
  options: IdentifyAnimeOptions = {}
): Promise<AIAnimeMatch | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[ai-identify] No ANTHROPIC_API_KEY set — skipping AI identification");
    return null;
  }
  if (base64Images.length === 0) return null;

  // Use at most 8 frames — later timestamps and inset crops are sorted first
  const images = base64Images.slice(0, 8);
  const hashtags = (options.hashtags ?? []).filter((t) => t.length >= 3).slice(0, 8);

  try {
    const imageBlocks: Anthropic.ImageBlockParam[] = images.map((img) => {
      const base64Data = img.replace(/^data:image\/[^;]+;base64,/, "");
      // Detect actual mime type from the data URL prefix
      let mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" = "image/jpeg";
      if (img.startsWith("data:image/png")) mimeType = "image/png";
      else if (img.startsWith("data:image/webp")) mimeType = "image/webp";
      else if (img.startsWith("data:image/gif")) mimeType = "image/gif";
      return {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64Data },
      };
    });

    const hashtagHint =
      hashtags.length > 0
        ? `\n\nTikTok hashtags from the video (often anime titles or character names with spaces removed): ${hashtags.map((t) => `#${t}`).join(", ")}. Use these as hints — e.g. "#akamegakil" means "Akame ga Kill". If the frames match a hashtag title, use that title with high confidence.`
        : "";

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `These are ${images.length} frame(s) from a TikTok about anime. The video may include creator commentary with anime shown in a small inset — identify the anime series, not the creator.${hashtagHint}`,
            },
          ],
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    // Extract JSON from the response (handle potential surrounding whitespace/text)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[ai-identify] No JSON in response:", text.slice(0, 200));
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as AIAnimeMatch;
    if (!parsed.title && parsed.confidence === "low") {
      console.log("[ai-identify] AI could not identify anime from images");
      return null;
    }

    console.log(`[ai-identify] Identified: "${parsed.title}" (${parsed.confidence} confidence)`);
    return parsed;
  } catch (err) {
    console.warn("[ai-identify] Claude API error:", err);
    return null;
  }
}
