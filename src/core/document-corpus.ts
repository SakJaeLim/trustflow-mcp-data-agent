import { basename, isAbsolute, relative, resolve } from "node:path";
import { readRegularFileBounded } from "./safe-file.ts";
import { sha256Hex, type CompanyXIntegrity } from "./companyx-integrity.ts";

export interface DocumentIndexItem {
  id: string;
  type: string;
  title: string;
  filename: string;
}

export const MAX_DOCUMENT_INDEX_BYTES = 1_048_576;
export const MAX_DOCUMENTS = 200;
export const MAX_DOCUMENT_BYTES = 1_048_576;
export const MAX_CORPUS_BYTES = 32 * 1_048_576;
export const MAX_CHUNKS_PER_DOCUMENT = 2_048;
export const EMBEDDING_BATCH_SIZE = 32;

export interface VerifiedDocumentChunk {
  docId: string;
  chunkIndex: number;
  content: string;
  chunkSha256: string;
  sourceSha256: string;
}

export interface VerifiedDocument extends DocumentIndexItem {
  content: string;
  bytes: number;
  sourceSha256: string;
  chunks: VerifiedDocumentChunk[];
}

export interface VerifiedDocumentCorpus {
  documents: VerifiedDocument[];
  chunks: VerifiedDocumentChunk[];
  generationSha256: string;
}

export function safeDocumentFilename(filename: string): string {
  if (
    !filename
    || filename.includes("\0")
    || filename.includes("/")
    || filename.includes("\\")
    || isAbsolute(filename)
    || basename(filename) !== filename
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u.test(filename)
  ) throw new Error(`Unsafe document filename: ${JSON.stringify(filename)}`);
  return filename;
}

export function parseDocumentIndex(indexBytes: Uint8Array): DocumentIndexItem[] {
  if (indexBytes.byteLength > MAX_DOCUMENT_INDEX_BYTES) {
    throw new Error(`Document index exceeds ${MAX_DOCUMENT_INDEX_BYTES} bytes.`);
  }
  const parsed = JSON.parse(Buffer.from(indexBytes).toString("utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_DOCUMENTS) {
    throw new Error(`Document index must contain 1-${MAX_DOCUMENTS} entries.`);
  }
  const items = parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid document index entry ${index}.`);
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.id)
      || typeof item.type !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.type)
      || typeof item.title !== "string" || !item.title.trim() || Buffer.byteLength(item.title, "utf8") > 1_024
      || typeof item.filename !== "string"
    ) throw new Error(`Invalid document index entry ${index}.`);
    return { id: item.id, type: item.type, title: item.title, filename: safeDocumentFilename(item.filename) };
  });
  const identity = (value: string): string => value.normalize("NFC").toLocaleLowerCase("en-US");
  if (new Set(items.map((item) => identity(item.id))).size !== items.length) throw new Error("Document index contains duplicate IDs.");
  if (new Set(items.map((item) => identity(item.filename))).size !== items.length) throw new Error("Document index contains duplicate filenames.");
  return items;
}

export async function loadDocumentIndex(documentsDirectory: string): Promise<DocumentIndexItem[]> {
  const root = resolve(documentsDirectory);
  const indexPath = resolve(root, "index.json");
  const indexBytes = (await readRegularFileBounded(indexPath, MAX_DOCUMENT_INDEX_BYTES)).bytes;
  return parseDocumentIndex(indexBytes);
}

export function loadVerifiedDocumentCorpus(integrity: CompanyXIntegrity): VerifiedDocumentCorpus {
  const index = parseDocumentIndex(integrity.readFile("documents/index.json"));
  const documents: VerifiedDocument[] = [];
  const chunks: VerifiedDocumentChunk[] = [];
  let corpusBytes = 0;
  for (const item of index) {
    const bytes = integrity.readFile(`documents/${safeDocumentFilename(item.filename)}`);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`${item.id} exceeds ${MAX_DOCUMENT_BYTES} bytes.`);
    corpusBytes += bytes.byteLength;
    if (corpusBytes > MAX_CORPUS_BYTES) throw new Error(`Document corpus exceeds ${MAX_CORPUS_BYTES} bytes.`);
    const content = bytes.toString("utf8");
    const sourceSha256 = sha256Hex(bytes);
    const documentChunks = splitMarkdown(content).map((chunk, chunkIndex) => ({
      docId: item.id,
      chunkIndex,
      content: chunk,
      chunkSha256: sha256Hex(Buffer.from(chunk, "utf8")),
      sourceSha256,
    }));
    if (documentChunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(`${item.id} exceeds ${MAX_CHUNKS_PER_DOCUMENT} chunks.`);
    }
    chunks.push(...documentChunks);
    documents.push({ ...item, content, bytes: bytes.byteLength, sourceSha256, chunks: documentChunks });
  }
  const generationSha256 = sha256Hex(Buffer.from(JSON.stringify({
    datasetSha256: integrity.datasetSha256,
    chunks: chunks.map(({ docId, chunkIndex, chunkSha256, sourceSha256 }) => ({ docId, chunkIndex, chunkSha256, sourceSha256 })),
  }), "utf8"));
  return { documents, chunks, generationSha256 };
}

export async function readDocumentMarkdown(
  documentsDirectory: string,
  filename: string,
): Promise<{ content: string; bytes: number }> {
  const root = resolve(documentsDirectory);
  const safeName = safeDocumentFilename(filename);
  const path = resolve(root, safeName);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Document path escaped corpus root: ${filename}`);
  }
  const file = await readRegularFileBounded(path, MAX_DOCUMENT_BYTES);
  return { content: file.bytes.toString("utf8"), bytes: file.size };
}

export function splitMarkdown(markdown: string, maxChars = 1_200, overlapChars = 160): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 64 || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("Invalid Markdown chunk limits.");
  }
  const normalized = markdown.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean).join("\n\n");
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + Math.floor(maxChars / 2)) end = paragraphBreak;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}
