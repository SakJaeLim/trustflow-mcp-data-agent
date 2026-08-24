import test from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { safeArchivePath, sha256Hex } from "../scripts/fetch-companyx.ts";
import { inspectZipArchive } from "../src/core/archive-safety.ts";

test("cross-platform dataset installer rejects ZIP path traversal", () => {
  for (const path of ["../outside.txt", "a/../../outside.txt", "/absolute.txt", "C:\\outside.txt"]) {
    assert.throws(() => safeArchivePath(path), /Unsafe ZIP entry path/);
  }
  assert.equal(safeArchivePath("documents/DOC-001.md"), "documents/DOC-001.md");

  const limits = {
    maxEntries: 10,
    maxCompressedBytes: 1_000_000,
    maxEntryUncompressedBytes: 20_000,
    maxTotalUncompressedBytes: 30_000,
    maxCompressionRatio: 500,
  };
  const safeZip = zipSync({ "root/file.txt": new TextEncoder().encode("safe") }, { level: 0 });
  assert.deepEqual(inspectZipArchive(safeZip, limits).map((item) => item.name), ["root/file.txt"]);
  const unsafeZip = zipSync({ "root\\data\\secret.txt": new TextEncoder().encode("secret") }, { level: 0 });
  assert.throws(() => inspectZipArchive(unsafeZip, limits), /Unsafe ZIP entry path/u);
  const compressedBomb = zipSync({ "root/large.txt": new Uint8Array(10_000) }, { level: 9 });
  assert.throws(() => inspectZipArchive(compressedBomb, { ...limits, maxCompressionRatio: 2 }), /compression ratio/u);
});

test("dataset installer SHA-256 helper is deterministic", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode("company-x")),
    "b12dc5da35b90a27140e4c5cea16afb53162505d75d8912cec19ed908f18e681",
  );
});
