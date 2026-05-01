import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { JsonV2Adapter, JsonV3Adapter } from "../../src/adapters/index.js";
import { clearTempDir, makeIndexData, makeLegacyV2Data, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("JsonV3Adapter", () => {
  const tmpDir = makeTempDir("ks-jsonv3-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("round-trips JSON v3 data through a custom source path", async () => {
    const sourcePath = `${tmpDir}/custom-v3.store`;
    const adapter = new JsonV3Adapter(sourcePath, 4);
    const data = makeIndexData();

    await adapter.write(data);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.equal(adapter.path(), sourcePath);
    assert.deepStrictEqual(loaded.entries, data.entries);
  });

  it("migrates forward from v2 content", async () => {
    const adapter = new JsonV3Adapter(`${tmpDir}/custom-v3.store`, 4);
    const migrated = await adapter.migrate(new JsonV2Adapter(`${tmpDir}/legacy.store`, 4), {
      ...makeIndexData(),
      version: 2,
    });
    assert.equal(migrated.version, 3);
  });

  it("reads legacy json files when they match the configured dimensions", async () => {
    const sourcePath = `${tmpDir}/custom-v3.store`;
    const payload = {
      version: 3,
      dimensions: 4,
      entries: {
        "/vault/legacy.md#0": {
          ...makeLegacyV2Data().entries["/vault/legacy.md"],
          heading: "intro",
          chunkIndex: 0,
        },
      },
    };
    fs.writeFileSync(sourcePath, JSON.stringify(payload));

    const adapter = new JsonV3Adapter(sourcePath, 4);
    const loaded = await adapter.read();
    assert.ok(loaded);
    assert.equal(loaded.version, 3);
  });
});