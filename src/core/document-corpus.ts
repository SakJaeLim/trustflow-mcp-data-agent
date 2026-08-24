import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

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

async function regularFile(path: string, maxBytes: number): Promise<number> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Document corpus path is not a regular file: ${path}`);
  if (details.size > maxBytes) throw new Error(`Document corpus file exceeds ${maxBytes} bytes: ${path}`);
  return details.size;
}

export async function loadDocumentIndex(documentsDirectory: string): Promise<DocumentIndexItem[]> {
  const root = resolve(documentsDirectory);
  const indexPath = resolve(root, "index.json");
  await regularFile(indexPath, MAX_DOCUMENT_INDEX_BYTES);
  const parsed = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
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
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("Document index contains duplicate IDs.");
  if (new Set(items.map((item) => item.filename)).size !== items.length) throw new Error("Document index contains duplicate filenames.");
  return items;
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
  const bytes = await regularFile(path, MAX_DOCUMENT_BYTES);
  return { content: await readFile(path, "utf8"), bytes };
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
