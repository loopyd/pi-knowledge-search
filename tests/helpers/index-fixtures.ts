import { KnowledgeIndex } from "../../src/index-store.js";
import type { Config, Embedder, IndexData, KbAdapter, LegacyIndexEntry } from "../../src/types.js";
import { makeConfig as makeAdapterConfig } from "./adapter-fixtures.js";

type MakeTestConfigOptions = {
  adapter?: KbAdapter;
  dimensions?: number;
  baseName?: string;
  dirs?: string[];
  fileExtensions?: string[];
  excludeDirs?: string[];
  provider?: Config["provider"];
  indexDir?: string;
  kbAdapterSourceUri?: string;
  knowledgeBases?: Config["knowledgeBases"];
};

export class StubEmbedder implements Embedder {
  constructor(private readonly message = "not used in these tests") {}

  async embed(): Promise<number[]> {
    throw new Error(this.message);
  }

  async embedBatch(): Promise<(number[] | null)[]> {
    throw new Error(this.message);
  }
}

export class TestEmbedder implements Embedder {
  constructor(
    private readonly embedImpl: (text: string, signal?: AbortSignal) => Promise<number[]>,
    private readonly embedBatchImpl: (
      texts: string[],
      signal?: AbortSignal,
      concurrency?: number
    ) => Promise<(number[] | null)[]>
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    return await this.embedImpl(text, signal);
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency?: number
  ): Promise<(number[] | null)[]> {
    return await this.embedBatchImpl(texts, signal, concurrency);
  }
}

export function makeTestConfig(dir: string, options: MakeTestConfigOptions = {}): Config {
  const adapter = options.adapter ?? "jsonl_v4";
  const dimensions = options.dimensions ?? 4;
  const baseName = options.baseName ?? "index";
  const indexDir = options.indexDir ?? dir;
  const config = makeAdapterConfig(indexDir, adapter, dimensions, baseName);

  return {
    ...config,
    dirs: options.dirs ?? config.dirs,
    fileExtensions: options.fileExtensions ?? config.fileExtensions,
    excludeDirs: options.excludeDirs ?? config.excludeDirs,
    provider: options.provider ?? config.provider,
    indexDir,
    kbAdapterSourceUri: options.kbAdapterSourceUri ?? config.kbAdapterSourceUri,
    knowledgeBases: options.knowledgeBases ?? config.knowledgeBases,
  };
}

export function makeLegacyV2Index(dimensions = 4): {
  version: 2;
  dimensions: number;
  entries: Record<string, LegacyIndexEntry>;
} {
  return {
    version: 2,
    dimensions,
    entries: {
      "/vault/legacy-v2.md": {
        relPath: "legacy-v2.md",
        sourceDir: "/vault",
        mtime: 222,
        vector: Array.from({ length: dimensions }, (_, index) => index + 1),
        excerpt: "legacy v2 excerpt",
      },
    },
  };
}

export function seedIndex(index: KnowledgeIndex, count: number, dims = 4): void {
  const internal = index as unknown as { data: IndexData };
  internal.data.reindexState = "paused";

  for (let indexValue = 0; indexValue < count; indexValue += 1) {
    internal.data.entries[`/vault/file-${indexValue}.md#0`] = {
      relPath: `file-${indexValue}.md`,
      sourceDir: "/vault",
      mtime: 1_700_000_000_000 + indexValue,
      vector: Array.from({ length: dims }, (_, dim) => Math.sin(indexValue + dim)),
      excerpt: `Excerpt for file ${indexValue}.`,
      heading: indexValue % 3 === 0 ? "intro" : `Section ${indexValue}`,
      chunkIndex: 0,
    };
  }
}