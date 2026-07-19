import type { TraceMoeResponse } from "@/types";
import { isValidSearchImage, toArrayBuffer } from "@/lib/image-bytes";

const BASE_URL = "https://api.trace.moe";

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.TRACE_MOE_API_KEY) {
    headers["x-trace-key"] = process.env.TRACE_MOE_API_KEY;
  }
  return headers;
}

export async function searchByImageUrl(imageUrl: string): Promise<TraceMoeResponse> {
  const url = `${BASE_URL}/search?url=${encodeURIComponent(imageUrl)}&cutBorders=true`;
  const response = await fetch(url, { headers: getHeaders() });
  if (!response.ok) {
    throw new Error(`trace.moe request failed: ${response.status}`);
  }
  return response.json();
}

export async function searchByBase64(base64Image: string): Promise<TraceMoeResponse> {
  // cutBorders must be a URL query parameter — the JSON body only accepts `image`.
  const response = await fetch(`${BASE_URL}/search?cutBorders=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getHeaders(),
    },
    body: JSON.stringify({ image: base64Image }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`trace.moe request failed: ${response.status} — ${body}`);
  }
  return response.json();
}

/**
 * Send image bytes as multipart/form-data.
 * More reliable than base64 JSON when the MIME type is unknown or large.
 */
export async function searchByBuffer(
  buffer: ArrayBuffer | Buffer | Uint8Array,
  mimeType: string
): Promise<TraceMoeResponse> {
  const bytes =
    buffer instanceof Buffer || buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer);

  if (!isValidSearchImage(bytes)) {
    throw new Error("trace.moe request skipped: invalid or empty image");
  }

  const form = new FormData();
  form.append("image", new Blob([toArrayBuffer(bytes)], { type: mimeType }), "frame.jpg");

  const response = await fetch(`${BASE_URL}/search?cutBorders=true`, {
    method: "POST",
    headers: getHeaders(), // no Content-Type — let fetch set the multipart boundary
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`trace.moe request failed: ${response.status} — ${body}`);
  }
  return response.json();
}
