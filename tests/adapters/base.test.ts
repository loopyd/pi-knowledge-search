import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIndexAdapter, JsonV2Adapter, JsonV3Adapter, JsonV4Adapter, SqliteV4Adapter } from "../../src/adapters/index.js";
import { adapterLocalPath, adapterSourceUri, clearTempDir, makeTempDir, removeTempDir } from "../helpers/adapter-fixtures.js";

describe("adapter base path resolution", () => {
  const tmpDir = makeTempDir("ks-adapter-base-");

  beforeEach(() => {
    clearTempDir(tmpDir);
  });

  after(() => {
    removeTempDir(tmpDir);
  });

  it("preserves an explicit source URI for the selected adapter", () => {
    const source = adapterSourceUri(tmpDir, "jsonl_v4", "custom-store");
    const adapter = createIndexAdapter(source, 4, "jsonl_v4");
    assert.equal(adapter.path(), adapterLocalPath(tmpDir, "jsonl_v4", "custom-store"));
  });

  it("derives sibling file paths for related adapters", () => {
    const sourcePath = adapterLocalPath(tmpDir, "jsonl_v4", "custom-store");
    const selectedSource = {
      selectedKind: "jsonl_v4" as const,
      selectedPath: sourcePath,
    };

    assert.equal(new JsonV4Adapter(selectedSource, 4).path(), sourcePath);
    assert.equal(
      new JsonV3Adapter(selectedSource, 4).path(),
      adapterLocalPath(tmpDir, "json_v3", "custom-store")
    );
    assert.equal(
      new JsonV2Adapter(selectedSource, 4).path(),
      adapterLocalPath(tmpDir, "json_v2", "custom-store")
    );
    assert.equal(
      new SqliteV4Adapter(selectedSource, 4).path(),
      adapterLocalPath(tmpDir, "sqlite_local", "custom-store")
    );
  });
});