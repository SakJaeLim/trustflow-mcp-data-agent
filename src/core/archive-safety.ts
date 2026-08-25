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
  crc32: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const ALLOWED_FLAGS = 0x080e;

let crcTable: Uint32Array | undefined;

function crc32Table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < crcTable.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

export function zipCrc32(bytes: Uint8Array): number {
  const table = crc32Table();
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function canonicalArchivePath(name: string): string {
  const directory = name.endsWith("/");
  if (
    !name
    || name.length > 1_024
    || name.normalize("NFC") !== name
    || name.includes("\0")
    || name.includes("\\")
    || name.startsWith("/")
    || /^[A-Za-z]:/u.test(name)
  ) throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(name)}`);
  const segments = name.split("/");
  if (directory) segments.pop();
  if (segments.length === 0 || segments.some((segment) =>
    !segment
    || segment === "."
    || segment === ".."
    || segment.length > 255
    || /[<>:"|?*\u0000-\u001f]/u.test(segment)
    || /[. ]$/u.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
  )) {
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
  if (view.getUint16(eocd + 20, true) !== 0) throw new Error("ZIP archive comments are not allowed.");
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
  const collisionNames = new Set<string>();
  const entries: ZipEntryMetadata[] = [];
  const localRanges: Array<{ start: number; end: number; name: string }> = [];
  let totalUncompressed = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`ZIP central directory entry ${index} is invalid.`);
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
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
    if (extraLength !== 0 || commentLength !== 0) {
      throw new Error(`ZIP central-directory extras and comments are not allowed: ${index}`);
    }
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new Error("Encrypted ZIP entries are not allowed.");
    if ((flags & ~ALLOWED_FLAGS) !== 0) throw new Error(`ZIP entry uses unsupported flags: ${index}`);
    if (method !== 0 && method !== 8) throw new Error(`ZIP compression method ${method} is not allowed.`);
    if (method === 0 && compressedBytes !== uncompressedBytes) {
      throw new Error(`Stored ZIP entry sizes differ: ${index}`);
    }
    const name = canonicalArchivePath(decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    if (names.has(name)) throw new Error(`ZIP contains a duplicate entry: ${name}`);
    names.add(name);
    const collisionName = name.replace(/\/$/u, "").normalize("NFC").toLocaleLowerCase("en-US");
    if (collisionNames.has(collisionName)) throw new Error(`ZIP contains a filesystem-equivalent duplicate entry: ${name}`);
    collisionNames.add(collisionName);
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
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressedBytes = view.getUint32(localOffset + 18, true);
    const localUncompressedBytes = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localExtraLength !== 0) throw new Error(`ZIP local-header extras are not allowed: ${name}`);
    const localNameEnd = localOffset + 30 + localNameLength;
    if (localNameEnd + localExtraLength > centralOffset) throw new Error(`ZIP local entry bounds are invalid: ${name}`);
    const localName = canonicalArchivePath(decodeName(bytes.subarray(localOffset + 30, localNameEnd)));
    if (localName !== name) throw new Error(`ZIP local and central names differ: ${name}`);
    if (localFlags !== flags || localMethod !== method) {
      throw new Error(`ZIP local and central flags or method differ: ${name}`);
    }
    const payloadStart = localNameEnd + localExtraLength;
    const payloadEnd = payloadStart + compressedBytes;
    if (!Number.isSafeInteger(payloadEnd) || payloadEnd > centralOffset) {
      throw new Error(`ZIP compressed payload bounds are invalid: ${name}`);
    }
    let localEnd = payloadEnd;
    if ((flags & DATA_DESCRIPTOR_FLAG) === 0) {
      if (localCrc32 !== crc32 || localCompressedBytes !== compressedBytes || localUncompressedBytes !== uncompressedBytes) {
        throw new Error(`ZIP local and central integrity metadata differ: ${name}`);
      }
    } else {
      const hasSignature = payloadEnd + 4 <= centralOffset && view.getUint32(payloadEnd, true) === DATA_DESCRIPTOR_SIGNATURE;
      const descriptorStart = payloadEnd + (hasSignature ? 4 : 0);
      const descriptorEnd = descriptorStart + 12;
      if (descriptorEnd > centralOffset
        || view.getUint32(descriptorStart, true) !== crc32
        || view.getUint32(descriptorStart + 4, true) !== compressedBytes
        || view.getUint32(descriptorStart + 8, true) !== uncompressedBytes) {
        throw new Error(`ZIP data descriptor differs from central metadata: ${name}`);
      }
      if ((localCrc32 !== 0 && localCrc32 !== crc32)
        || (localCompressedBytes !== 0 && localCompressedBytes !== compressedBytes)
        || (localUncompressedBytes !== 0 && localUncompressedBytes !== uncompressedBytes)) {
        throw new Error(`ZIP local integrity metadata is inconsistent: ${name}`);
      }
      localEnd = descriptorEnd;
    }
    localRanges.push({ start: localOffset, end: localEnd, name });
    entries.push({ name, compressedBytes, uncompressedBytes, directory: name.endsWith("/"), crc32 });
    offset = next;
  }
  if (offset !== eocd) throw new Error("ZIP central directory entry count is inconsistent.");
  localRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  if (localRanges[0]?.start !== 0) throw new Error("ZIP contains bytes before the first local entry.");
  for (let index = 1; index < localRanges.length; index += 1) {
    const previous = localRanges[index - 1]!;
    const current = localRanges[index]!;
    if (current.start < previous.end) throw new Error(`ZIP local entries overlap: ${previous.name}, ${current.name}`);
    if (current.start !== previous.end) throw new Error(`ZIP contains uncovered bytes between local entries: ${previous.name}, ${current.name}`);
  }
  if (localRanges.at(-1)?.end !== centralOffset) throw new Error("ZIP contains uncovered bytes before the central directory.");
  return entries;
}

export function verifyUnzippedZipEntries(
  metadata: readonly ZipEntryMetadata[],
  entries: Readonly<Record<string, Uint8Array>>,
): void {
  const expectedNames = new Set(metadata.map((entry) => entry.name));
  const actualNames = Object.keys(entries);
  if (actualNames.length !== expectedNames.size || actualNames.some((name) => !expectedNames.has(name))) {
    throw new Error("ZIP extracted entry names differ from authenticated metadata.");
  }
  for (const item of metadata) {
    const bytes = entries[item.name];
    if (!bytes || bytes.byteLength !== item.uncompressedBytes || zipCrc32(bytes) !== item.crc32) {
      throw new Error(`ZIP extracted entry integrity check failed: ${item.name}`);
    }
  }
}
