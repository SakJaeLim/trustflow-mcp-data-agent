import type { PostgresDatabase, PostgresReadTransaction } from "../adapters/postgres.ts";
import type { Embedder } from "../adapters/ollama-embedder.ts";
import type { SqlQueryResult, SqlRunner } from "../tools/sqlite-fixture.ts";
import { SqliteFixture } from "../tools/sqlite-fixture.ts";
import type { CompanyXIntegrity } from "./companyx-integrity.ts";
import { sha256Hex } from "./companyx-integrity.ts";
import { EMBEDDING_BATCH_SIZE, type VerifiedDocumentCorpus } from "./document-corpus.ts";
import { readRegularFileBounded } from "./safe-file.ts";

interface TableSpec {
  name: string;
  columns: readonly string[];
  seedColumns: readonly string[];
  timestampColumns: readonly string[];
}

const TABLES: readonly TableSpec[] = [
  { name: "departments", columns: ["id", "name", "head_id", "created_at"], seedColumns: ["id", "name", "head_id"], timestampColumns: ["created_at"] },
  { name: "employees", columns: ["id", "name", "email", "position", "dept_id", "hire_date", "salary", "is_active", "created_at"], seedColumns: ["id", "name", "email", "position", "dept_id", "hire_date", "salary", "is_active"], timestampColumns: ["created_at"] },
  { name: "clients", columns: ["id", "name", "industry", "region", "company_size", "contact_name", "contact_email", "registered_at", "is_active", "created_at"], seedColumns: ["id", "name", "industry", "region", "company_size", "contact_name", "contact_email", "registered_at", "is_active"], timestampColumns: ["created_at"] },
  { name: "products", columns: ["id", "name", "category", "description", "price_monthly", "version", "release_date", "status", "created_at"], seedColumns: ["id", "name", "category", "description", "price_monthly", "version", "release_date", "status"], timestampColumns: ["created_at"] },
  { name: "contracts", columns: ["id", "client_id", "product_id", "manager_id", "contract_type", "amount", "start_date", "end_date", "status", "created_at"], seedColumns: ["id", "client_id", "product_id", "manager_id", "contract_type", "amount", "start_date", "end_date", "status"], timestampColumns: ["created_at"] },
  { name: "projects", columns: ["id", "name", "client_id", "manager_id", "contract_id", "status", "start_date", "end_date", "budget", "description", "created_at"], seedColumns: ["id", "name", "client_id", "manager_id", "contract_id", "status", "start_date", "end_date", "budget", "description"], timestampColumns: ["created_at"] },
  { name: "sales", columns: ["id", "contract_id", "client_id", "product_id", "amount", "sale_date", "quarter", "category", "region", "created_at"], seedColumns: ["id", "contract_id", "client_id", "product_id", "amount", "sale_date", "quarter", "category", "region"], timestampColumns: ["created_at"] },
  { name: "support_tickets", columns: ["id", "client_id", "product_id", "assignee_id", "title", "description", "priority", "status", "created_at", "resolved_at"], seedColumns: ["id", "client_id", "product_id", "assignee_id", "title", "description", "priority", "status", "created_at", "resolved_at"], timestampColumns: ["created_at", "resolved_at"] },
] as const;

const EXPECTED_READER_TABLES = new Set([...TABLES.map((table) => table.name), "document_chunks"]);
const MAX_BUSINESS_ROW_BYTES = 64 * 1_024;
const MAX_VECTOR_ROW_BYTES = 2 * 1_048_576;
const MAX_CONTENT_BYTES = 1_048_576;
const MAX_METADATA_BYTES = 16_384;
const MAX_EMBEDDING_TEXT_BYTES = 64 * 1_024;

interface DatabaseIdentityRow {
  role_name: string;
  database_name: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolconnlimit: number;
  membership_count: string;
  owned_object_count: string;
}

interface GrantRow {
  table_schema: string;
  table_name: string;
  privilege_type: string;
}

interface ChunkIntegrityRow {
  doc_id: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown> | string;
  embedding_text: string;
  content_bytes: number;
  metadata_bytes: number;
  embedding_bytes: number;
  row_bytes: number;
  dimensions: number;
  created_at: string;
}

export interface EmbeddingAttestation {
  model: string;
  hashes: ReadonlyMap<string, string>;
  embeddingsSha256: string;
  manifestSha256?: string;
}

export async function loadEmbeddingAttestation(
  path: string,
  integrity: CompanyXIntegrity,
  corpus: VerifiedDocumentCorpus,
  expectedModel: string,
): Promise<EmbeddingAttestation> {
  const file = await readRegularFileBounded(path, 128 * 1_024);
  const parsed = JSON.parse(file.bytes.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Embedding attestation must be an object.");
  const item = parsed as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "datasetSha256,dimensions,embeddingModel,entries,generationSha256,schemaVersion"
    || item.schemaVersion !== "1.0"
    || item.datasetSha256 !== integrity.datasetSha256
    || item.generationSha256 !== corpus.generationSha256
    || item.embeddingModel !== expectedModel
    || item.dimensions !== 768
    || !Array.isArray(item.entries)
    || item.entries.length !== corpus.chunks.length) {
    throw new Error("Embedding attestation header, model, dataset, generation, or cardinality is invalid.");
  }
  const expectedKeys = new Set(corpus.chunks.map((chunk) => `${chunk.docId}:${chunk.chunkIndex}`));
  const hashes = new Map<string, string>();
  for (const [index, raw] of item.entries.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Embedding attestation entry ${index + 1} is invalid.`);
    const entry = raw as Record<string, unknown>;
    const key = `${entry.docId}:${entry.chunkIndex}`;
    if (Object.keys(entry).sort().join(",") !== "chunkIndex,docId,embeddingSha256"
      || typeof entry.docId !== "string"
      || !Number.isInteger(entry.chunkIndex)
      || typeof entry.embeddingSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.embeddingSha256)
      || !expectedKeys.has(key)
      || hashes.has(key)) {
      throw new Error(`Embedding attestation entry ${index + 1} failed schema, key-set, or digest validation.`);
    }
    hashes.set(key, entry.embeddingSha256);
  }
  if (hashes.size !== expectedKeys.size || [...expectedKeys].some((key) => !hashes.has(key))) {
    throw new Error("Embedding attestation key set differs from the verified corpus.");
  }
  return {
    model: expectedModel,
    hashes,
    embeddingsSha256: sha256Hex(Buffer.from(stableJson([...hashes].sort(([left], [right]) => left.localeCompare(right))), "utf8")),
    manifestSha256: sha256Hex(file.bytes),
  };
}

export interface PostgresIntegrityResult {
  tableHashes: Record<string, string>;
  businessTablesSha256: string;
  vectorGenerationSha256?: string;
  vectorStateSha256?: string;
  embeddingsSha256?: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizedDate(value: Date): string {
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  const milliseconds = value.getMilliseconds();
  return time === "00:00:00" && milliseconds === 0
    ? date
    : `${date} ${time}${milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0").replace(/0+$/u, "")}`}`;
}

function normalizedNumber(value: string): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integerInput = "0", fractionInput = ""] = unsigned.split(".");
  const integer = integerInput.replace(/^0+(?=\d)/u, "") || "0";
  const fraction = fractionInput.replace(/0+$/u, "");
  const normalized = fraction ? `${integer}.${fraction}` : integer;
  return negative && normalized !== "0" ? `-${normalized}` : normalized;
}

function canonicalValue(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) return normalizedDate(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Database integrity row contains a non-finite number.");
    return normalizedNumber(String(value));
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) return normalizedNumber(value);
    const timestamp = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z)?$/u);
    if (timestamp) {
      const fraction = (timestamp[3] ?? "").replace(/0+$/u, "");
      return timestamp[2] === "00:00:00" && !fraction
        ? timestamp[1]
        : `${timestamp[1]} ${timestamp[2]}${fraction ? `.${fraction}` : ""}`;
    }
    return value;
  }
  throw new Error("Database integrity row contains an unsupported value type.");
}

function canonicalRows(rows: Record<string, unknown>[], columns: readonly string[]): string {
  return JSON.stringify(rows.map((row) => columns.map((column) => canonicalValue(row[column]))));
}

function stableJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function metadata(value: ChunkIntegrityRow["metadata"]): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("PostgreSQL vector metadata is invalid.");
  return parsed as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`PostgreSQL returned an invalid ${label}.`);
  return parsed;
}

function selection(table: TableSpec): string {
  const timestamps = new Set(table.timestampColumns);
  return table.columns.map((column) => timestamps.has(column)
    ? `to_char(t.${column}, 'YYYY-MM-DD HH24:MI:SS.US') AS ${column}`
    : `t.${column}`
  ).join(", ");
}

export function embeddingSha256(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite scalar.");
    bytes.writeFloatLE(Math.fround(value), index * 4);
  });
  return sha256Hex(bytes);
}

function parseVector(value: string): number[] {
  if (Buffer.byteLength(value, "utf8") > MAX_EMBEDDING_TEXT_BYTES) throw new Error("PostgreSQL embedding text exceeds the safety limit.");
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 768 || parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("PostgreSQL embedding vector is malformed.");
  }
  return parsed as number[];
}

export async function createEmbeddingAttestation(
  corpus: VerifiedDocumentCorpus,
  embedder: Embedder,
  model: string,
): Promise<EmbeddingAttestation> {
  const vectors: number[][] = [];
  for (let offset = 0; offset < corpus.chunks.length; offset += EMBEDDING_BATCH_SIZE) {
    vectors.push(...await embedder.embed(corpus.chunks
      .slice(offset, offset + EMBEDDING_BATCH_SIZE)
      .map((chunk) => `search_document: ${chunk.content}`)));
  }
  if (vectors.length !== corpus.chunks.length) throw new Error("Embedding attestation cardinality mismatch.");
  const hashes = new Map<string, string>();
  corpus.chunks.forEach((chunk, index) => {
    const vector = vectors[index];
    if (!vector) throw new Error(`Embedding attestation is missing ${chunk.docId}:${chunk.chunkIndex}.`);
    hashes.set(`${chunk.docId}:${chunk.chunkIndex}`, embeddingSha256(vector));
  });
  return {
    model,
    hashes,
    embeddingsSha256: sha256Hex(Buffer.from(stableJson([...hashes].sort(([left], [right]) => left.localeCompare(right))), "utf8")),
  };
}

async function verifyReaderRole(database: PostgresReadTransaction): Promise<void> {
  const [identity] = await database.queryRows<DatabaseIdentityRow>(
    `SELECT current_user AS role_name,
            current_database() AS database_name,
            r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
            r.rolreplication, r.rolbypassrls, r.rolconnlimit,
            (SELECT COUNT(*)::text FROM pg_auth_members m WHERE m.member = r.oid) AS membership_count,
            ((SELECT COUNT(*) FROM pg_class c WHERE c.relowner = r.oid)
              + (SELECT COUNT(*) FROM pg_namespace n WHERE n.nspowner = r.oid)
              + (SELECT COUNT(*) FROM pg_proc p WHERE p.proowner = r.oid))::text AS owned_object_count
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  if (!identity
    || identity.role_name !== "policygraph_reader"
    || identity.database_name !== "companyx"
    || identity.rolsuper
    || identity.rolcreatedb
    || identity.rolcreaterole
    || identity.rolinherit
    || identity.rolreplication
    || identity.rolbypassrls
    || identity.rolconnlimit !== 5
    || integer(identity.membership_count, "membership count") !== 0
    || integer(identity.owned_object_count, "owned-object count") !== 0) {
    throw new Error("PostgreSQL identity or reader-role hardening does not match the Company-X runtime contract.");
  }

  const grants = await database.queryRows<GrantRow>(
    `SELECT table_schema, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = current_user
      ORDER BY table_schema, table_name, privilege_type`,
  );
  if (grants.length !== EXPECTED_READER_TABLES.size
    || grants.some((grant) => grant.table_schema !== "public"
      || grant.privilege_type !== "SELECT"
      || !EXPECTED_READER_TABLES.has(grant.table_name))
    || new Set(grants.map((grant) => grant.table_name)).size !== EXPECTED_READER_TABLES.size) {
    throw new Error("PostgreSQL reader table grants exceed or differ from the exact Company-X allow-list.");
  }
}

export async function verifyPostgresCompanyX(
  database: PostgresReadTransaction,
  integrity: CompanyXIntegrity,
  corpus: VerifiedDocumentCorpus,
  requireVector: boolean,
  embeddingAttestation?: EmbeddingAttestation,
): Promise<PostgresIntegrityResult> {
  await verifyReaderRole(database);
  if (requireVector && !embeddingAttestation) throw new Error("Vector verification requires a trusted embedding attestation.");

  const expectedDatabase = SqliteFixture.fromIntegrity(integrity);
  const tableHashes: Record<string, string> = {};
  try {
    for (const table of TABLES) {
      const expected = await expectedDatabase.query(`SELECT ${table.seedColumns.join(", ")} FROM ${table.name} ORDER BY id`);
      const [countRow] = await database.queryRows<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table.name}`);
      const actualCount = integer(countRow?.count, `${table.name} row count`);
      if (actualCount !== expected.rows.length) throw new Error(`PostgreSQL table row count drifted: ${table.name}`);
      const actual = await database.queryRows<Record<string, unknown>>(
        `SELECT ${selection(table)}, pg_column_size(t)::integer AS __row_bytes
           FROM ${table.name} AS t
          WHERE pg_column_size(t) <= ${MAX_BUSINESS_ROW_BYTES}
          ORDER BY t.id
          LIMIT $1`,
        [expected.rows.length + 1],
      );
      if (actual.length !== expected.rows.length
        || actual.some((row) => integer(row.__row_bytes, `${table.name} row size`) > MAX_BUSINESS_ROW_BYTES)
        || actual.some((row) => row.created_at === null)) {
        throw new Error(`PostgreSQL table contains oversized, missing, or extra rows: ${table.name}`);
      }
      const expectedCanonical = canonicalRows(expected.rows, table.seedColumns);
      const actualSeedCanonical = canonicalRows(actual, table.seedColumns);
      if (actualSeedCanonical !== expectedCanonical) {
        throw new Error(`PostgreSQL table drifted from the verified Company-X seed: ${table.name}`);
      }
      const actualCanonical = canonicalRows(actual, table.columns);
      tableHashes[table.name] = sha256Hex(Buffer.from(actualCanonical, "utf8"));
    }
  } finally {
    await expectedDatabase.close();
  }

  let vectorStateSha256: string | undefined;
  if (requireVector && embeddingAttestation) {
    const [countRow] = await database.queryRows<{ count: string }>("SELECT COUNT(*)::text AS count FROM document_chunks");
    const actualCount = integer(countRow?.count, "document_chunks row count");
    if (actualCount !== corpus.chunks.length) throw new Error("PostgreSQL vector corpus has missing or extra chunks.");
    const rows = await database.queryRows<ChunkIntegrityRow>(
      `SELECT d.doc_id,
              d.chunk_index,
              d.content,
              d.metadata,
              d.embedding::text AS embedding_text,
              octet_length(d.content)::integer AS content_bytes,
              octet_length(d.metadata::text)::integer AS metadata_bytes,
              octet_length(d.embedding::text)::integer AS embedding_bytes,
              pg_column_size(d)::integer AS row_bytes,
              vector_dims(d.embedding)::integer AS dimensions,
              to_char(d.created_at, 'YYYY-MM-DD HH24:MI:SS.US') AS created_at
         FROM document_chunks AS d
        WHERE d.embedding IS NOT NULL
          AND octet_length(d.content) <= ${MAX_CONTENT_BYTES}
          AND octet_length(d.metadata::text) <= ${MAX_METADATA_BYTES}
          AND octet_length(d.embedding::text) <= ${MAX_EMBEDDING_TEXT_BYTES}
          AND pg_column_size(d) <= ${MAX_VECTOR_ROW_BYTES}
        ORDER BY d.doc_id, d.chunk_index
        LIMIT $1`,
      [corpus.chunks.length + 1],
    );
    if (rows.length !== corpus.chunks.length) throw new Error("PostgreSQL vector corpus contains an oversized, null, missing, or extra chunk.");
    const documents = new Map(corpus.documents.map((document) => [document.id, document]));
    const expectedChunks = new Map(corpus.chunks.map((chunk) => [`${chunk.docId}:${chunk.chunkIndex}`, chunk]));
    const seen = new Set<string>();
    const state: unknown[] = [];
    for (const row of rows) {
      const key = `${row.doc_id}:${row.chunk_index}`;
      if (seen.has(key)) throw new Error(`PostgreSQL vector corpus contains a duplicate chunk: ${key}`);
      seen.add(key);
      const expected = expectedChunks.get(key);
      const document = documents.get(row.doc_id);
      const expectedEmbeddingSha256 = embeddingAttestation.hashes.get(key);
      const actualEmbeddingSha256 = embeddingSha256(parseVector(row.embedding_text));
      const item = metadata(row.metadata);
      const expectedMetadata = expected && document && expectedEmbeddingSha256 ? {
        type: document.type,
        title: document.title,
        filename: document.filename,
        datasetSha256: integrity.datasetSha256,
        generationSha256: corpus.generationSha256,
        sourceSha256: expected.sourceSha256,
        chunkSha256: expected.chunkSha256,
        embeddingModel: embeddingAttestation.model,
        embeddingSha256: expectedEmbeddingSha256,
        embeddingAttestationSha256: embeddingAttestation.manifestSha256,
      } : undefined;
      if (!expected
        || !document
        || !expectedEmbeddingSha256
        || row.content_bytes > MAX_CONTENT_BYTES
        || row.metadata_bytes > MAX_METADATA_BYTES
        || row.embedding_bytes > MAX_EMBEDDING_TEXT_BYTES
        || row.row_bytes > MAX_VECTOR_ROW_BYTES
        || row.dimensions !== 768
        || !row.created_at
        || row.content !== expected.content
        || sha256Hex(Buffer.from(row.content, "utf8")) !== expected.chunkSha256
        || actualEmbeddingSha256 !== expectedEmbeddingSha256
        || !expectedMetadata
        || stableJson(item) !== stableJson(expectedMetadata)) {
        throw new Error(`PostgreSQL vector chunk failed provenance verification: ${key}`);
      }
      state.push([key, expected.chunkSha256, actualEmbeddingSha256, sha256Hex(Buffer.from(stableJson(item), "utf8")), canonicalValue(row.created_at)]);
    }
    if (seen.size !== expectedChunks.size || [...expectedChunks.keys()].some((key) => !seen.has(key))) {
      throw new Error("PostgreSQL vector corpus key set differs from the verified corpus.");
    }
    vectorStateSha256 = sha256Hex(Buffer.from(stableJson(state), "utf8"));
  }

  return {
    tableHashes,
    businessTablesSha256: sha256Hex(Buffer.from(stableJson(tableHashes), "utf8")),
    vectorGenerationSha256: requireVector ? corpus.generationSha256 : undefined,
    vectorStateSha256,
    embeddingsSha256: requireVector ? embeddingAttestation?.embeddingsSha256 : undefined,
  };
}

export class AttestedPostgresSqlRunner implements SqlRunner {
  private readonly database: PostgresDatabase;
  private readonly integrity: CompanyXIntegrity;
  private readonly corpus: VerifiedDocumentCorpus;
  private readonly expectedBusinessTablesSha256: string;

  constructor(
    database: PostgresDatabase,
    integrity: CompanyXIntegrity,
    corpus: VerifiedDocumentCorpus,
    expectedBusinessTablesSha256: string,
  ) {
    this.database = database;
    this.integrity = integrity;
    this.corpus = corpus;
    this.expectedBusinessTablesSha256 = expectedBusinessTablesSha256;
  }

  async query(sql: string, maxRows?: number): Promise<SqlQueryResult> {
    return this.database.withReadTransaction(async (transaction) => {
      const current = await verifyPostgresCompanyX(transaction, this.integrity, this.corpus, false);
      if (current.businessTablesSha256 !== this.expectedBusinessTablesSha256) {
        throw new Error("PostgreSQL business-table state changed after runtime attestation.");
      }
      const result = await transaction.query(sql, maxRows);
      return { ...result, datasetStateSha256: current.businessTablesSha256 };
    });
  }

  async close(): Promise<void> {
    await this.database.close();
  }
}
