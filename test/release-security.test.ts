import test from "node:test";
import assert from "node:assert/strict";
import { scanReleaseFiles } from "../src/core/release-secret-scan.ts";

test("release scan checks every path, embedded binary signatures, and UTF-16 text", () => {
  const token = `ghp_${"A".repeat(32)}`;
  const privateKeyHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const utf16 = Buffer.from(privateKeyHeader, "utf16le");
  const nestedArchive = Buffer.concat([Buffer.from("prefix"), Buffer.from([0x50, 0x4b, 0x03, 0x04])]);
  const findings = scanReleaseFiles([
    { path: "scripts/check-secrets.ts", bytes: Buffer.from(token, "utf8") },
    { path: "docs/utf16.txt", bytes: utf16 },
    { path: "docs/binary.dat", bytes: nestedArchive },
  ]);
  assert.ok(findings.some((item) => item.file === "scripts/check-secrets.ts" && item.rule === "cloud-token"));
  assert.ok(findings.some((item) => item.file === "docs/utf16.txt" && item.rule === "private-key"));
  assert.ok(findings.some((item) => item.file === "docs/binary.dat" && item.rule === "nested-archive"));
});

test("release scan accepts ordinary source text and zero-heavy binary containers", () => {
  assert.deepEqual(scanReleaseFiles([{ path: "README.md", bytes: Buffer.from("PolicyGraph release", "utf8") }]), []);
  const binary = Buffer.alloc(8_192, 0);
  binary.set([0x00, 0xd8, 0x00, 0x00, 0xd8, 0x00, 0x00, 0x00]);
  assert.deepEqual(scanReleaseFiles([{ path: "demo.mp4", bytes: binary }]), []);

  const token = `ghp_${"C".repeat(32)}`;
  const hiddenLe = Buffer.from(binary);
  Buffer.from(token, "utf16le").copy(hiddenLe, 512);
  const leFindings = scanReleaseFiles([{ path: "hidden-le.bin", bytes: hiddenLe }]);
  assert.ok(leFindings.some((item) => item.file === "hidden-le.bin" && item.rule === "cloud-token"));

  const encodedBe = Buffer.from(token, "utf16le");
  for (let index = 0; index < encodedBe.length; index += 2) {
    [encodedBe[index], encodedBe[index + 1]] = [encodedBe[index + 1]!, encodedBe[index]!];
  }
  const hiddenBeAtOddOffset = Buffer.from(binary);
  encodedBe.copy(hiddenBeAtOddOffset, 513);
  const beFindings = scanReleaseFiles([{ path: "hidden-be.bin", bytes: hiddenBeAtOddOffset }]);
  assert.ok(beFindings.some((item) => item.file === "hidden-be.bin" && item.rule === "cloud-token"));
});

test("release scan finds ASCII secrets around invalid UTF-8 and after long UTF-16BE prefixes", () => {
  const token = Buffer.from(`ghp_${"B".repeat(32)}`, "ascii");
  const invalidUtf8 = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), token, Buffer.from([0xff])]);
  const prefix = "가".repeat(5_000);
  const beSource = Buffer.from(`${prefix}\n${token.toString("ascii")}`, "utf16le");
  const utf16be = Buffer.allocUnsafe(beSource.length + 2);
  utf16be[0] = 0xfe;
  utf16be[1] = 0xff;
  for (let index = 0; index < beSource.length; index += 2) {
    utf16be[index + 2] = beSource[index + 1]!;
    utf16be[index + 3] = beSource[index]!;
  }
  const findings = scanReleaseFiles([
    { path: "invalid-utf8.bin", bytes: invalidUtf8 },
    { path: "long-utf16be.txt", bytes: utf16be },
  ]);
  assert.ok(findings.some((item) => item.file === "invalid-utf8.bin" && item.rule === "cloud-token"));
  assert.ok(findings.some((item) => item.file === "long-utf16be.txt" && item.rule === "cloud-token"));
});

test("release scan fails closed on malformed UTF-16", () => {
  const malformed = Buffer.from([0xff, 0xfe, 0x41]);
  assert.ok(scanReleaseFiles([{ path: "malformed.txt", bytes: malformed }])
    .some((item) => item.rule === "malformed-utf16"));
});
