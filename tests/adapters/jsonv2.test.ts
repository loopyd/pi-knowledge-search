import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { JsonV2Adapter } from "../../src/adapters/index.js";
import { clearTempDir, makeIndexData, makeLegacyV2Data, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("JsonV2Adapter", () => {
  const tmpDir = makeTempDir("ks-jsonv2-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("reads legacy JSON data and inflates heading metadata", async () => {
    const sourcePath = `${tmpDir}/legacy-v2.store`;
    fs.writeFileSync(sourcePath, JSON.stringify(makeLegacyV2Data()));

    const adapter = new JsonV2Adapter(sourcePath, 4);
    const data = await adapter.read();

    assert.ok(data);
    assert.equal(adapter.path(), sourcePath);
    assert.deepStrictEqual(data.entries["/vault/legacy.md#0"], {
      relPath: "legacy.md",
      sourceDir: "/vault",
      mtime: 456,
      vector: [10, 11, 12, 13],
      excerpt: "legacy excerpt",
      heading: "intro",
      chunkIndex: 0,
    });
  });

  it("rejects mismatched dimensions", async () => {
    const sourcePath = `${tmpDir}/legacy-v2.store`;
    fs.writeFileSync(sourcePath, JSON.stringify(makeLegacyV2Data(8)));

    const adapter = new JsonV2Adapter(sourcePath, 4);
    assert.equal(await adapter.read(), null);
  });

  it("streams large legacy JSON payloads when the safety threshold is exceeded", async () => {
    const sourcePath = `${tmpDir}/legacy-v2.store`;
    fs.writeFileSync(sourcePath, JSON.stringify(makeLegacyV2Data()));

    const originalLimit = JsonV2Adapter.limit;
    JsonV2Adapter.limit = 1;
    try {
      const adapter = new JsonV2Adapter(sourcePath, 4);
      const data = await adapter.read();
      assert.ok(data);
      assert.deepStrictEqual(data.entries["/vault/legacy.md#0"].vector, [10, 11, 12, 13]);
    } finally {
      JsonV2Adapter.limit = originalLimit;
    }
  });

  it("is a read-only adapter", async () => {
    const adapter = new JsonV2Adapter(`${tmpDir}/legacy-v2.store`, 4);
    await assert.rejects(() => adapter.write(), /read-only legacy adapter/);
  });
});