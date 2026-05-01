import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { SqliteV4LocalAdapter } from "../../src/adapters/index.js";
import { clearTempDir, makeLegacyV2Data, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("SqliteV4LocalAdapter", () => {
  const tmpDir = makeTempDir("ks-sqlite-local-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("migrates legacy json content into the selected sqlite source path", async () => {
    const sourcePath = `${tmpDir}/custom-index.db`;
    const legacyPath = `${tmpDir}/custom-index.json`;
    fs.writeFileSync(legacyPath, JSON.stringify(makeLegacyV2Data()));

    const adapter = new SqliteV4LocalAdapter(sourcePath, 4);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.ok(fs.existsSync(sourcePath));
    assert.ok(!fs.existsSync(legacyPath));
    await adapter.close();
  });
});