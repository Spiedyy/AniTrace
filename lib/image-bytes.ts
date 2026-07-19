/** trace.moe rejects empty images (400) and images over 1 MB (413). */
export const TRACE_MOE_MAX_BYTES = 1_000_000;
const TRACE_MOE_MIN_BYTES = 400;

const JPEG = [0xff, 0xd8, 0xff] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47] as const;
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46] as const;

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

/** True when bytes look like a non-empty image trace.moe can decode. */
export function isValidSearchImage(bytes: Uint8Array): boolean {
  if (bytes.length < TRACE_MOE_MIN_BYTES || bytes.length > TRACE_MOE_MAX_BYTES) {
    return false;
  }
  return (
    hasMagic(bytes, JPEG) ||
    hasMagic(bytes, PNG) ||
    (hasMagic(bytes, WEBP_RIFF) && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45)
  );
}

/** Copy Buffer/Uint8Array into a standalone ArrayBuffer (avoids pooled-buffer bugs). */
export function toArrayBuffer(data: Buffer | Uint8Array): ArrayBuffer {
  const view = data instanceof Buffer ? new Uint8Array(data) : data;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

/** Parse a data-URL or raw base64 string into validated image bytes. */
export function bytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
  try {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    return isValidSearchImage(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
