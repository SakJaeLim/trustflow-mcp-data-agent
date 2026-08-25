import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";
import { safeArchivePath, sha256Hex } from "../scripts/fetch-companyx.ts";
import { inspectZipArchive, verifyUnzippedZipEntries } from "../src/core/archive-safety.ts";

const ZIP_LIMITS = {
  maxEntries: 10,
  maxCompressedBytes: 1_000_000,
  maxEntryUncompressedBytes: 20_000,
  maxTotalUncompressedBytes: 30_000,
  maxCompressionRatio: 500,
};

test("cross-platform dataset installer rejects ZIP path traversal", () => {
  for (const path of ["../outside.txt", "a/../../outside.txt", "/absolute.txt", "C:\\outside.txt"]) {
    assert.throws(() => safeArchivePath(path), /Unsafe ZIP entry path/);
  }
  assert.equal(safeArchivePath("documents/DOC-001.md"), "documents/DOC-001.md");

  const safeZip = zipSync({ "root/file.txt": new TextEncoder().encode("safe") }, { level: 0 });
  assert.deepEqual(inspectZipArchive(safeZip, ZIP_LIMITS).map((item) => item.name), ["root/file.txt"]);
  const unsafeZip = zipSync({ "root\\data\\secret.txt": new TextEncoder().encode("secret") }, { level: 0 });
  assert.throws(() => inspectZipArchive(unsafeZip, ZIP_LIMITS), /Unsafe ZIP entry path/u);
  const compressedBomb = zipSync({ "root/large.txt": new Uint8Array(10_000) }, { level: 9 });
  assert.throws(() => inspectZipArchive(compressedBomb, { ...ZIP_LIMITS, maxCompressionRatio: 2 }), /compression ratio/u);
});

test("ZIP inspection binds local headers, non-overlapping ranges, and extracted CRCs", () => {
  const safeZip = zipSync({ "root/file.txt": new TextEncoder().encode("safe") }, { level: 0 });
  const metadata = inspectZipArchive(safeZip, ZIP_LIMITS);
  const extracted = unzipSync(safeZip);
  verifyUnzippedZipEntries(metadata, extracted);
  extracted["root/file.txt"]![0] ^= 1;
  assert.throws(() => verifyUnzippedZipEntries(metadata, extracted), /integrity check failed/u);

  const inconsistent = Uint8Array.from(safeZip);
  new DataView(inconsistent.buffer).setUint32(14, 0, true);
  assert.throws(() => inspectZipArchive(inconsistent, ZIP_LIMITS), /local and central integrity metadata differ/u);

  const overlapping = zipSync({
    "root/a.txt": new TextEncoder().encode("a".repeat(1_000)),
    "root/b.txt": new TextEncoder().encode("b".repeat(1_000)),
  }, { level: 9 });
  const view = new DataView(overlapping.buffer, overlapping.byteOffset, overlapping.byteLength);
  let eocd = overlapping.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0);
  const firstCentral = view.getUint32(eocd + 16, true);
  const firstCentralLength = 46 + view.getUint16(firstCentral + 28, true)
    + view.getUint16(firstCentral + 30, true) + view.getUint16(firstCentral + 32, true);
  const secondCentral = firstCentral + firstCentralLength;
  const firstLocal = view.getUint32(firstCentral + 42, true);
  const secondLocal = view.getUint32(secondCentral + 42, true);
  const payloadStart = firstLocal + 30 + view.getUint16(firstLocal + 26, true) + view.getUint16(firstLocal + 28, true);
  const overlappingCompressedSize = secondLocal - payloadStart + 1;
  view.setUint32(firstCentral + 20, overlappingCompressedSize, true);
  view.setUint32(firstLocal + 18, overlappingCompressedSize, true);
  assert.throws(() => inspectZipArchive(overlapping, ZIP_LIMITS), /overlap/u);

  const eocdOffset = safeZip.byteLength - 22;
  const comment = Buffer.from(`ghp_${"C".repeat(32)}`, "ascii");
  const commented = Buffer.concat([Buffer.from(safeZip), comment]);
  new DataView(commented.buffer, commented.byteOffset, commented.byteLength)
    .setUint16(eocdOffset + 20, comment.byteLength, true);
  assert.throws(() => inspectZipArchive(commented, ZIP_LIMITS), /comments are not allowed/u);

  const safeView = new DataView(safeZip.buffer, safeZip.byteOffset, safeZip.byteLength);
  const centralOffset = safeView.getUint32(eocdOffset + 16, true);
  const withPreamble = Buffer.concat([Buffer.from([0x41]), Buffer.from(safeZip)]);
  const preambleView = new DataView(withPreamble.buffer, withPreamble.byteOffset, withPreamble.byteLength);
  const shiftedCentral = centralOffset + 1;
  preambleView.setUint32(shiftedCentral + 42, 1, true);
  preambleView.setUint32(eocdOffset + 1 + 16, shiftedCentral, true);
  assert.throws(() => inspectZipArchive(withPreamble, ZIP_LIMITS), /before the first local entry/u);

  const withGap = Buffer.concat([
    Buffer.from(safeZip.subarray(0, centralOffset)),
    Buffer.from([0x42]),
    Buffer.from(safeZip.subarray(centralOffset)),
  ]);
  const gapView = new DataView(withGap.buffer, withGap.byteOffset, withGap.byteLength);
  gapView.setUint32(eocdOffset + 1 + 16, centralOffset + 1, true);
  assert.throws(() => inspectZipArchive(withGap, ZIP_LIMITS), /uncovered bytes before the central directory/u);
});

test("dataset installer SHA-256 helper is deterministic", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode("company-x")),
    "b12dc5da35b90a27140e4c5cea16afb53162505d75d8912cec19ed908f18e681",
  );
});
