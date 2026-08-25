import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface BoundedFile {
  bytes: Buffer;
  size: number;
  identity: { dev: number; ino: number; nlink: number };
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

export async function readRegularFileBounded(path: string, maxBytes: number): Promise<BoundedFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid file byte limit.");
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Path is not a regular file: ${path}`);
  if (before.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error(`File changed while opening: ${path}`);
    const capacity = Math.min(maxBytes + 1, opened.size + 1);
    const buffer = Buffer.allocUnsafe(capacity);
    let offset = 0;
    while (offset < capacity) {
      const { bytesRead } = await handle.read(buffer, offset, capacity - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size || offset > maxBytes) {
      throw new Error(`File changed or exceeded ${maxBytes} bytes while reading: ${path}`);
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isFile() || !sameFile(opened, after)) {
      throw new Error(`File changed while reading: ${path}`);
    }
    return {
      bytes,
      size: bytes.byteLength,
      identity: { dev: opened.dev, ino: opened.ino, nlink: opened.nlink },
    };
  } finally {
    await handle.close();
  }
}
