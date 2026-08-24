export interface ZipSafetyLimits {
  maxEntries: number;
  maxCompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
}

export interface ZipEntryMetadata {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function canonicalArchivePath(name: string): string {
  const directory = name.endsWith("/");
  if (
    !name
    || name.includes("\0")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
  ) throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  const segments = name.split("/");
  if (directory) segments.pop();
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  }
  return `${segments.join("/")}${directory ? "/" : ""}`;
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 22 - 65_535);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === view.byteLength) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing.");
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function inspectZipArchive(bytes: Uint8Array, limits: ZipSafetyLimits): ZipEntryMetadata[] {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new Error(`ZIP exceeds ${limits.maxCompressedBytes} compressed bytes.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error("Multi-disk ZIP archives are not allowed.");
  if (entryCount === 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Empty or ZIP64 archives are not allowed.");
  }
  if (entryCount > limits.maxEntries) throw new Error(`ZIP exceeds ${limits.maxEntries} entries.`);
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.byteLength) {
    throw new Error("ZIP central directory bounds are invalid.");
  }

  const names = new Set<string>();
  const entries: ZipEntryMetadata[] = [];
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP central directory entry ${index} is invalid.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || diskStart !== 0 || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP entry ${index} uses unsupported or invalid metadata.`);
    }
    if ((flags & 0x1) !== 0) throw new Error("Encrypted ZIP entries are not allowed.");
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not allowed.`);
    const name = canonicalArchivePath(decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    if (names.has(name)) throw new Error(`ZIP contains a duplicate entry: ${name}`);
    names.add(name);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`ZIP symbolic links are not allowed: ${name}`);
    if (uncompressedBytes > limits.maxEntryUncompressedBytes) {
      throw new Error(`ZIP entry exceeds ${limits.maxEntryUncompressedBytes} expanded bytes: ${name}`);
    }
    const ratio = uncompressedBytes / Math.max(1, compressedBytes);
    if (ratio > limits.maxCompressionRatio) throw new Error(`ZIP entry compression ratio is unsafe: ${name}`);
    totalUncompressed += uncompressedBytes;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error(`ZIP exceeds ${limits.maxTotalUncompressedBytes} total expanded bytes.`);
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`ZIP local header is invalid: ${name}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameEnd = localOffset + 30 + localNameLength;
    if (localNameEnd + localExtraLength > centralOffset) throw new Error(`ZIP local entry bounds are invalid: ${name}`);
    const localName = canonicalArchivePath(decodeName(bytes.subarray(localOffset + 30, localNameEnd)));
    if (localName !== name) throw new Error(`ZIP local and central names differ: ${name}`);
    entries.push({ name, compressedBytes, uncompressedBytes, directory: name.endsWith("/") });
    offset = next;
  }
  if (offset !== eocd) throw new Error("ZIP central directory entry count is inconsistent.");
  return entries;
}
