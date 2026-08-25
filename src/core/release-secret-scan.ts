import { createHash } from "node:crypto";
import { COMPANYX_DATASET_SHA256 } from "./companyx-integrity.ts";

export interface ReleaseScanFile {
  path: string;
  bytes: Uint8Array;
  sha256?: string;
}

export interface ReleaseSecretFinding {
  file: string;
  line: number;
  rule: string;
}

const patterns = [
  { id: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { id: "cloud-token", expression: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,})\b/u },
  { id: "legacy-db-password", expression: /policygraph_(?:admin|reader)_dev_only/u },
  { id: "credential-url", expression: /postgres(?:ql)?:\/\/[^:\s/]+:(?!REPLACE_WITH_|\$\{)[^@\s]+@/iu },
] as const;

const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const sqliteMagic = Buffer.from("SQLite format 3\0", "ascii");

interface Utf16Decode {
  text?: string;
  malformed: boolean;
}

function utf16Text(bytes: Buffer): Utf16Decode {
  if (bytes.length < 2) return { malformed: false };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if ((bytes.length - 2) % 2 !== 0) return { malformed: true };
    try {
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2)), malformed: false };
    } catch {
      return { malformed: true };
    }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    if ((bytes.length - 2) % 2 !== 0) return { malformed: true };
    const swapped = Buffer.allocUnsafe(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]!;
      swapped[index - 1] = bytes[index]!;
    }
    try {
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(swapped), malformed: false };
    } catch {
      return { malformed: true };
    }
  }
  if (bytes.length < 4) return { malformed: false };
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 8_192);
  let evenZero = 0;
  let oddZero = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenZero += 1;
    if (bytes[index + 1] === 0) oddZero += 1;
  }
  const pairs = sampleLength / 2;
  const evenZeroRatio = evenZero / pairs;
  const oddZeroRatio = oddZero / pairs;
  // BOM-less UTF-16 ASCII has NULs concentrated in one byte lane. Binary
  // containers can have many NULs in both lanes and must not be decoded as
  // UTF-16 merely because one lane crosses the threshold.
  if (pairs === 0
    || Math.max(evenZeroRatio, oddZeroRatio) < 0.3
    || Math.min(evenZeroRatio, oddZeroRatio) > 0.1) return { malformed: false };
  if (bytes.length % 2 !== 0) return { malformed: true };
  if (oddZero >= evenZero) {
    try {
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes), malformed: false };
    } catch {
      return { malformed: true };
    }
  }
  const swapped = Buffer.allocUnsafe(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  try {
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(swapped), malformed: false };
  } catch {
    return { malformed: true };
  }
}

function decodedTexts(bytes: Buffer): { texts: string[]; malformedUtf16: boolean } {
  // Latin-1 is a one-byte mapping, so ASCII credentials remain visible even
  // when surrounding bytes are not valid UTF-8.
  const texts: string[] = [bytes.toString("latin1")];
  try {
    texts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // Binary files are still checked by signatures and hashes below.
  }
  try {
    const utf16 = utf16Text(bytes);
    if (utf16.text !== undefined && !texts.includes(utf16.text)) texts.push(utf16.text);
    return { texts, malformedUtf16: utf16.malformed };
  } catch {
    return { texts, malformedUtf16: true };
  }
}

function* utf16AsciiProjections(bytes: Buffer): Generator<string> {
  if (bytes.indexOf(0) === -1) return;
  for (const start of [0, 1]) {
    const pairs = Math.floor((bytes.length - start) / 2);
    if (pairs < 1) continue;
    const projected = Buffer.allocUnsafe(pairs);
    for (let pair = 0; pair < pairs; pair += 1) {
      const offset = start + pair * 2;
      const left = bytes[offset]!;
      const right = bytes[offset + 1]!;
      if (left === 0 && right <= 0x7f) projected[pair] = right;
      else if (right === 0 && left <= 0x7f) projected[pair] = left;
      else projected[pair] = 0xff;
    }
    yield projected.toString("latin1");
  }
}

export function scanReleaseFiles(files: readonly ReleaseScanFile[]): ReleaseSecretFinding[] {
  const findings: ReleaseSecretFinding[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number, rule: string): void => {
    const key = `${file}\0${line}\0${rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push({ file, line, rule });
    }
  };

  for (const file of files) {
    const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    const digest = file.sha256 ?? createHash("sha256").update(bytes).digest("hex");
    if (digest === COMPANYX_DATASET_SHA256) add(file.path, 1, "official-dataset-archive");
    if (bytes.indexOf(zipMagic) !== -1) add(file.path, 1, "nested-archive");
    if (bytes.indexOf(sqliteMagic) !== -1) add(file.path, 1, "database-file");
    const decoded = decodedTexts(bytes);
    if (decoded.malformedUtf16) add(file.path, 1, "malformed-utf16");
    const scanContent = (content: string): void => {
      for (const [index, line] of content.split(/\r?\n/u).entries()) {
        for (const pattern of patterns) {
          pattern.expression.lastIndex = 0;
          if (pattern.expression.test(line)) add(file.path, index + 1, pattern.id);
        }
      }
    };
    // Scan alignment-aware ASCII projections independently of whole-file
    // UTF-16 classification so interleaved credentials inside binary
    // containers remain visible without treating the container as text.
    for (const content of decoded.texts) scanContent(content);
    for (const content of utf16AsciiProjections(bytes)) scanContent(content);
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule));
}

export function assertReleaseFilesSafe(files: readonly ReleaseScanFile[]): void {
  const findings = scanReleaseFiles(files);
  if (findings.length > 0) {
    throw new Error(`Secret scan failed: ${findings.map((item) => `${item.file}:${item.line} [${item.rule}]`).join(", ")}`);
  }
}
