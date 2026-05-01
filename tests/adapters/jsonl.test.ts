import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { JsonV2Adapter, JsonV3Adapter, JsonlIndexAdapter } from "../../src/adapters/index.js";
import { clearTempDir, makeIndexData, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("JsonlIndexAdapter", () => {
  const tmpDir = makeTempDir("ks-jsonl-chain-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("migrates legacy json content into a sibling jsonl file", async () => {
    const baseName = "knowledge-store";
    const legacyPath = `${tmpDir}/${baseName}.json`;
    const targetPath = `${tmpDir}/${baseName}.jsonl`;
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({ version: 3, dimensions: 4, entries: makeIndexData().entries })
    );

    const adapter = new JsonlIndexAdapter(targetPath, 4);
    const loaded = await adapter.read();

    assert.ok(loaded);
    assert.ok(fs.existsSync(targetPath));
    assert.ok(!fs.existsSync(legacyPath));
  });

  it("exposes the legacy streaming threshold passthrough", () => {
    const realThreshold = JsonlIndexAdapter.threshold;
    const realV2Threshold = JsonV2Adapter.limit;
    const realV3Threshold = JsonV3Adapter.limit;
    JsonlIndexAdapter.threshold = 321;
    try {
      assert.equal(JsonlIndexAdapter.threshold, 321);
      assert.equal(JsonV2Adapter.limit, 321);
      assert.equal(JsonV3Adapter.limit, 321);
    } finally {
      JsonlIndexAdapter.threshold = realThreshold;
      JsonV2Adapter.limit = realV2Threshold;
      JsonV3Adapter.limit = realV3Threshold;
    }
  });
});