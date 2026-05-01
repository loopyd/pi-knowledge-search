import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { JsonV3Adapter, JsonV4Adapter } from "../../src/adapters/index.js";
import { clearTempDir, makeIndexData, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("JsonV4Adapter", () => {
  const tmpDir = makeTempDir("ks-jsonv4-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("round-trips JSONL data through a custom source path", async () => {
    const sourcePath = `${tmpDir}/custom-v4.store`;
    const adapter = new JsonV4Adapter(sourcePath, 4);
    const data = makeIndexData();

    await adapter.write(data);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.equal(adapter.path(), sourcePath);
    assert.equal(loaded.reindexState, "paused");
    assert.deepStrictEqual(loaded.entries, data.entries);
  });

  it("rejects JSONL files with a mismatched version", async () => {
    const sourcePath = `${tmpDir}/custom-v4.store`;
    fs.writeFileSync(sourcePath, `${JSON.stringify({ type: "meta", version: 999, dimensions: 4 })}\n`);

    const adapter = new JsonV4Adapter(sourcePath, 4);
    assert.equal(await adapter.read(), null);
  });

  it("migrates forward from v3 content", async () => {
    const adapter = new JsonV4Adapter(`${tmpDir}/custom-v4.store`, 4);
    const migrated = await adapter.migrate(new JsonV3Adapter(`${tmpDir}/legacy.store`, 4), {
      ...makeIndexData(),
      version: 3,
    });
    assert.equal(migrated.version, 4);
  });
});