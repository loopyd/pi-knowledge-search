import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JsonV4Adapter, SqliteV4Adapter } from "../../src/adapters/index.js";
import { clearTempDir, makeIndexData, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("SqliteV4Adapter", () => {
  const tmpDir = makeTempDir("ks-sqlitev4-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("round-trips sqlite-backed index data through a custom source path", async () => {
    const sourcePath = `${tmpDir}/custom-index.db`;
    const adapter = new SqliteV4Adapter(sourcePath, 4);
    const data = makeIndexData();

    await adapter.write(data);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.equal(adapter.path(), sourcePath);
    assert.deepStrictEqual(loaded.entries, data.entries);
    await adapter.close();
  });

  it("accepts migrations from jsonl v4 data", async () => {
    const adapter = new SqliteV4Adapter(`${tmpDir}/custom-index.db`, 4);
    const migrated = await adapter.migrateFrom(new JsonV4Adapter(`${tmpDir}/legacy.store`, 4), makeIndexData());
    assert.equal(migrated.version, 4);
    await adapter.close();
  });
});