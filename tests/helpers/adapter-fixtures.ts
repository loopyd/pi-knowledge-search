import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config, IndexData, KbAdapter, LegacyIndexEntry } from "../../src/types.js";

export function makeTempDir(prefix = "ks-adapter-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function clearTempDir(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

export function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function adapterExtension(adapter: KbAdapter): string {
  switch (adapter) {
    case "json_v2":
    case "json_v3":
      return ".json";
    case "sqlite_local":
      return ".sqlite";
    case "jsonl_v4":
    default:
      return ".jsonl";
  }
}

export function adapterLocalPath(dir: string, adapter: KbAdapter, baseName = "index"): string {
  return path.join(dir, `${baseName}${adapterExtension(adapter)}`);
}

export function adapterSourceUri(dir: string, adapter: KbAdapter, baseName = "index"): string {
  return pathToFileURL(adapterLocalPath(dir, adapter, baseName)).toString();
}

export function makeIndexData(dimensions = 4): IndexData {
  return {
    version: 4,
    dimensions,
    reindexState: "paused",
    entries: {
      "/vault/doc.md#0": {
        relPath: "doc.md",
        sourceDir: "/vault",
        mtime: 123,
        vector: Array.from({ length: dimensions }, (_, index) => index + 1),
        excerpt: "sample excerpt",
        heading: "intro",
        chunkIndex: 0,
      },
    },
  };
}

export function makeLegacyV2Entries(dimensions = 4): Record<string, LegacyIndexEntry> {
  return {
    "/vault/legacy.md": {
      relPath: "legacy.md",
      sourceDir: "/vault",
      mtime: 456,
      vector: Array.from({ length: dimensions }, (_, index) => index + 10),
      excerpt: "legacy excerpt",
    },
  };
}

export function makeLegacyV2Data(dimensions = 4): {
  version: 2;
  dimensions: number;
  entries: Record<string, LegacyIndexEntry>;
} {
  return {
    version: 2,
    dimensions,
    entries: makeLegacyV2Entries(dimensions),
  };
}

export function makeConfig(
  dir: string,
  adapter: KbAdapter = "jsonl_v4",
  dimensions = 4,
  baseName = "index"
): Config {
  return {
    dirs: ["/tmp/does-not-matter"],
    fileExtensions: [".md"],
    excludeDirs: [],
    dimensions,
    provider: null,
    indexDir: dir,
    kbAdapter: adapter,
    kbAdapterSourceUri: adapterSourceUri(dir, adapter, baseName),
    knowledgeBases: [],
  };
}