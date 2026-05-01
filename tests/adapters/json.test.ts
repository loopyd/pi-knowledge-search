import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { JsonIndexAdapter } from "../../src/adapters/index.js";
import { clearTempDir, makeLegacyV2Data, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("JsonIndexAdapter", () => {
  const tmpDir = makeTempDir("ks-json-chain-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("migrates v2 content in-place without deleting the target file", async () => {
    const sourcePath = `${tmpDir}/custom-index.json`;
    fs.writeFileSync(sourcePath, JSON.stringify(makeLegacyV2Data()));

    const adapter = new JsonIndexAdapter(sourcePath, 4);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.ok(fs.existsSync(sourcePath));
    const raw = JSON.parse(fs.readFileSync(sourcePath, "utf-8")) as { version: number };
    assert.equal(raw.version, 3);
  });
});