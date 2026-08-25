const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1_048_576;

export function localHttpBaseUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (
    url.protocol !== "http:"
    || (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]")
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Ollama base URL must be an uncredentialed loopback HTTP origin.");
  }
  return url.origin;
}

export async function readJsonResponseBounded(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid HTTP response byte limit.");
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new Error(`HTTP response exceeds ${maxBytes} bytes.`);
    }
  }
  if (!response.body) throw new Error("HTTP response body is missing.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response_too_large");
        throw new Error(`HTTP response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}
