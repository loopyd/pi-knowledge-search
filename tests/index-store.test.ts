import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { KnowledgeIndex, dotProduct } from "../src/index-store.js";
import {
  ChainAdapter,
  JsonV2Adapter,
  JsonV3Adapter,
  JsonV4Adapter,
  JsonlIndexAdapter,
  SqliteV4Adapter,
} from "../src/adapters/index.js";
import type { Config, Embedder, IndexAdapter, IndexData } from "../src/types.js";

describe("dotProduct", () => {
  it("returns 0 for orthogonal vectors", () => {
    assert.equal(dotProduct([1, 0, 0], [0, 1, 0]), 0);
  });

  it("returns 1 for identical unit vectors", () => {
    const vector = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    assert.ok(Math.abs(dotProduct(vector, vector) - 1) < 1e-10);
  });

  it("returns -1 for opposite unit vectors", () => {
    assert.equal(dotProduct([1, 0, 0], [-1, 0, 0]), -1);
  });

  it("computes correct dot product", () => {
    assert.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  });

  it("handles empty vectors", () => {
    assert.equal(dotProduct([], []), 0);
  });

  it("handles mismatched lengths (uses shorter)", () => {
    assert.equal(dotProduct([1, 2], [3, 4, 5]), 11);
  });

  it("works with high-dimensional vectors", () => {
    const dim = 512;
    const a = new Array(dim).fill(1 / Math.sqrt(dim));
    const b = new Array(dim).fill(1 / Math.sqrt(dim));
    assert.ok(Math.abs(dotProduct(a, b) - 1) < 1e-10);
  });
});

class StubEmbedder implements Embedder {
  async embed(): Promise<number[]> {
    throw new Error("not used in these tests");
  }

  async embedBatch(): Promise<(number[] | null)[]> {
    throw new Error("not used in these tests");
  }
}

class TestEmbedder implements Embedder {
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

function makeConfig(dir: string, dimensions = 4): Config {
  return {
    dirs: ["/tmp/does-not-matter"],
    fileExtensions: [".md"],
    excludeDirs: [],
    dimensions,
    provider: null,
    indexDir: dir,
    kbAdapter: "jsonl_v4",
    kbAdapterSourceUri: pathToFileURL(path.join(dir, "index.jsonl")).toString(),
    knowledgeBases: [],
  };
}

function makeLegacyV2Index(dimensions = 4) {
  return {
    version: 2,
    dimensions,
    entries: {
      "/vault/legacy-v2.md": {
        relPath: "legacy-v2.md",
        sourceDir: "/vault",
        mtime: 222,
        vector: [1, 2, 3, 4],
        excerpt: "legacy v2 excerpt",
      },
    },
  };
}

function trackMigrations<TClient>(
  adapter: IndexAdapter<IndexData, TClient>,
  route: string[]
): IndexAdapter<IndexData, TClient> {
  const instrumented = adapter as IndexAdapter<IndexData, TClient> & {
    migrateFrom: IndexAdapter<IndexData, TClient>["migrateFrom"];
  };
  const migrateFrom = adapter.migrateFrom.bind(adapter);

  instrumented.migrateFrom = async (source, data) => {
    route.push(`${source.kind()}@${source.version()}->${adapter.kind()}@${adapter.version()}`);
    return await migrateFrom(source, data);
  };

  return adapter;
}

describe("KnowledgeIndex JSONL load/save and migration", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-index-store-"));
  });

  beforeEach(() => {
    for (const file of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, file), { force: true, recursive: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(index: KnowledgeIndex, count: number, dims = 4): void {
    const internal = index as unknown as {
      data: {
        version: number;
        dimensions: number;
        reindexState: "running" | "paused";
        entries: Record<string, unknown>;
      };
    };
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

  it("save + load round-trips entries unchanged", async () => {
    const config = makeConfig(tmpDir);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 42);

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);

    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();

    const writerData = (writer as unknown as { data: { entries: Record<string, unknown> } }).data;
    const readerData = (reader as unknown as { data: { entries: Record<string, unknown> } }).data;

    assert.equal(reader.chunkCount(), writer.chunkCount());
    assert.deepStrictEqual(readerData, writerData);
  });

  it("load returns an empty index when no file exists", async () => {
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards a corrupt legacy index file instead of throwing", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.json"), "{ this is not json !!");
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards a JSONL index with a mismatched version", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "index.jsonl"),
      [
        JSON.stringify({ type: "meta", version: 999, dimensions: 4 }),
        JSON.stringify({
          type: "entry",
          key: "a#0",
          entry: {
            relPath: "a.md",
            sourceDir: "/vault",
            mtime: 1,
            vector: [1, 0, 0, 0],
            excerpt: "x",
            heading: "intro",
            chunkIndex: 0,
          },
        }),
      ].join("\n") + "\n"
    );
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("load discards a JSONL index with mismatched dimensions", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "index.jsonl"),
      `${JSON.stringify({ type: "meta", version: 4, dimensions: 1024 })}\n`
    );
    const reader = new KnowledgeIndex(makeConfig(tmpDir, 4), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("save writes atomically via a .tmp file + rename", async () => {
    const writer = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    seed(writer, 5);
    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);
    assert.ok(fs.existsSync(path.join(tmpDir, "index.jsonl")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "index.jsonl.tmp")));
  });

  it("round-trips many entries through JSONL persistence", async () => {
    const config = makeConfig(tmpDir, 256);
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 500, 256);

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);

    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 500);
  });

  it("migrates a legacy v3 index.json into v4 index.jsonl", async () => {
    const legacyEntries = {
      "/vault/file-a.md#0": {
        relPath: "file-a.md",
        sourceDir: "/vault",
        mtime: 123,
        vector: [1, 2, 3, 4],
        excerpt: "legacy excerpt",
        heading: "intro",
        chunkIndex: 0,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({ version: 3, dimensions: 4, entries: legacyEntries })
    );

    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();

    const data = (reader as unknown as { data: IndexData }).data;
    assert.equal(data.version, 4);
    assert.deepStrictEqual(data.entries, legacyEntries);
    assert.ok(fs.existsSync(path.join(tmpDir, "index.jsonl")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "index.json")));
  });

  it("migrates a large legacy v3 index.json through the streaming fallback path", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({
        version: 3,
        dimensions: 4,
        entries: {
          "/vault/file-b.md#0": {
            relPath: "file-b.md",
            sourceDir: "/vault",
            mtime: 456,
            vector: [4, 3, 2, 1],
            excerpt: "legacy streamed excerpt",
            heading: "intro",
            chunkIndex: 0,
          },
        },
      })
    );

    const realThreshold = JsonlIndexAdapter.legacyJsonStreamingThresholdBytes;
    JsonlIndexAdapter.legacyJsonStreamingThresholdBytes = 1;
    try {
      const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
      await reader.load();
      assert.equal(reader.chunkCount(), 1);
    } finally {
      JsonlIndexAdapter.legacyJsonStreamingThresholdBytes = realThreshold;
    }
  });

  it("migrates a legacy v2 index.json into v4 jsonl", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(makeLegacyV2Index()));
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    const data = (reader as unknown as { data: IndexData }).data;
    assert.equal(data.version, 4);
    assert.deepStrictEqual(data.entries["/vault/legacy-v2.md#0"], {
      relPath: "legacy-v2.md",
      sourceDir: "/vault",
      mtime: 222,
      vector: [1, 2, 3, 4],
      excerpt: "legacy v2 excerpt",
      heading: "intro",
      chunkIndex: 0,
    });
  });

  it("routes sqlite_local migration through v2 -> v3 -> v4 before sqlite", async () => {
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(makeLegacyV2Index()));
    const route: string[] = [];
    const chain = new ChainAdapter(trackMigrations(new SqliteV4Adapter(tmpDir, 4), route), [
      trackMigrations(new JsonV4Adapter(tmpDir, 4), route),
      trackMigrations(new JsonV3Adapter(tmpDir, 4), route),
      trackMigrations(new JsonV2Adapter(tmpDir, 4), route),
    ]);

    const data = await chain.read();
    assert.ok(data);
    assert.deepStrictEqual(route, [
      "json_v2@2->json_v3@3",
      "json_v3@3->jsonl_v4@4",
      "jsonl_v4@4->sqlite_local@4",
    ]);
    await chain.close();
  });

  it("discards unsupported legacy v1 index.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "/vault/legacy-v1.md": {
            relPath: "legacy-v1.md",
            sourceDir: "/vault",
            mtime: 111,
            vector: [4, 3, 2, 1],
            excerpt: "legacy v1 excerpt",
          },
        },
      })
    );
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 0);
  });

  it("round-trips entries through the sqlite_local adapter", async () => {
    const config = { ...makeConfig(tmpDir), kbAdapter: "sqlite_local" as const, kbAdapterSourceUri: pathToFileURL(path.join(tmpDir, "index.sqlite")).toString() };
    const writer = new KnowledgeIndex(config, new StubEmbedder());
    seed(writer, 12);

    const saveMethod = (writer as unknown as { save: () => Promise<void> }).save;
    await saveMethod.call(writer);
    await writer.close();

    const reader = new KnowledgeIndex(config, new StubEmbedder());
    await reader.load();
    assert.ok(fs.existsSync(path.join(tmpDir, "index.sqlite")));
    assert.equal(reader.chunkCount(), writer.chunkCount());
  });
});

describe("KnowledgeIndex runtime behavior", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-index-runtime-"));
  });

  beforeEach(() => {
    for (const file of fs.readdirSync(tmpDir)) {
      fs.rmSync(path.join(tmpDir, file), { recursive: true, force: true });
    }
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists reindex state changes on close without duplicating no-op updates", async () => {
    const index = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());

    index.setReindexState("paused");
    index.setReindexState("paused");
    await index.close();

    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.reindexState(), "paused");
  });

  it("searches by score, deduplicates per file, and filters low scores", async () => {
    const index = new KnowledgeIndex(
      makeConfig(tmpDir),
      new TestEmbedder(
        async () => [1, 0],
        async () => {
          throw new Error("not used");
        }
      )
    );
    const internal = index as unknown as { data: IndexData };
    internal.data.entries = {
      "/vault/file-a.md#0": {
        relPath: "file-a.md",
        sourceDir: "/vault",
        mtime: 1,
        vector: [0.95, 0],
        excerpt: "best chunk",
        heading: "intro",
        chunkIndex: 0,
      },
      "/vault/file-a.md#1": {
        relPath: "file-a.md",
        sourceDir: "/vault",
        mtime: 1,
        vector: [0.7, 0],
        excerpt: "second chunk",
        heading: "section",
        chunkIndex: 1,
      },
      "/vault/file-b.md#0": {
        relPath: "file-b.md",
        sourceDir: "/vault",
        mtime: 1,
        vector: [0.4, 0],
        excerpt: "second file",
        heading: "intro",
        chunkIndex: 0,
      },
      "/vault/file-c.md#0": {
        relPath: "file-c.md",
        sourceDir: "/vault",
        mtime: 1,
        vector: [0.1, 0],
        excerpt: "below threshold",
        heading: "intro",
        chunkIndex: 0,
      },
    };

    const results = await index.search("query", 5);

    assert.deepStrictEqual(results, [
      {
        path: "/vault/file-a.md",
        score: 0.95,
        excerpt: "best chunk",
        heading: "intro",
      },
      {
        path: "/vault/file-b.md",
        score: 0.4,
        excerpt: "second file",
        heading: "intro",
      },
    ]);
    assert.equal(index.size(), 3);
    assert.equal(index.chunkCount(), 4);
  });

  it("updates a file from watcher flow, strips frontmatter, and skips null vectors", async () => {
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const filePath = path.join(docsDir, "guide.md");
    fs.writeFileSync(
      filePath,
      [
        "---",
        "title: Guide",
        "---",
        "",
        "## Intro",
        "",
        "This is a sufficiently long chunk of markdown content for indexing.",
        "",
        "## Details",
        "",
        "This is another sufficiently long chunk of markdown content for indexing.",
      ].join("\n")
    );

    const embedTexts: string[][] = [];
    const index = new KnowledgeIndex(
      makeConfig(tmpDir),
      new TestEmbedder(
        async () => {
          throw new Error("not used");
        },
        async (texts) => {
          embedTexts.push([...texts]);
          return texts.map((_, index) => (index === 0 ? [0.9, 0.1, 0, 0] : null));
        }
      )
    );

    await index.updateFile(filePath, docsDir);

    const internal = index as unknown as { data: IndexData };
    const keys = Object.keys(internal.data.entries);
    assert.deepStrictEqual(keys, [`${filePath}#0`]);
    assert.equal(internal.data.entries[keys[0]].relPath, "guide.md");
    assert.ok(embedTexts[0][0].includes("Title: guide"));
    assert.ok(embedTexts[0][0].includes("## Intro"));
    assert.ok(!embedTexts[0][0].includes("title: Guide"));

    await index.close();
    const reader = new KnowledgeIndex(makeConfig(tmpDir), new StubEmbedder());
    await reader.load();
    assert.equal(reader.chunkCount(), 1);
  });

  it("removes files when watcher paths disappear or become too small", async () => {
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const filePath = path.join(docsDir, "small.md");
    fs.writeFileSync(filePath, "This is long enough to be indexed on the first pass.");

    const index = new KnowledgeIndex(
      makeConfig(tmpDir),
      new TestEmbedder(
        async () => {
          throw new Error("not used");
        },
        async () => [[1, 0, 0, 0]]
      )
    );

    await index.updateFile(filePath, docsDir);
    assert.equal(index.chunkCount(), 1);

    fs.writeFileSync(filePath, "too short");
    await index.updateFile(filePath, docsDir);
    assert.equal(index.chunkCount(), 0);

    fs.writeFileSync(filePath, "This is long enough to be indexed again after shrinking.");
    await index.updateFile(filePath, docsDir);
    assert.equal(index.chunkCount(), 1);

    fs.rmSync(filePath, { force: true });
    await index.updateFile(filePath, docsDir);
    assert.equal(index.chunkCount(), 0);
  });

  it("syncs directories, respects excludes, reports progress, and removes stale files", async () => {
    const docsDir = path.join(tmpDir, "docs");
    const excludedDir = path.join(docsDir, "skip-me");
    const hiddenDir = path.join(docsDir, ".hidden");
    fs.mkdirSync(excludedDir, { recursive: true });
    fs.mkdirSync(hiddenDir, { recursive: true });

    const keptFile = path.join(docsDir, "kept.md");
    const skippedFile = path.join(excludedDir, "ignored.md");
    const hiddenFile = path.join(hiddenDir, "secret.md");

    fs.writeFileSync(
      keptFile,
      "## Kept\n\nThis document is long enough to be indexed and included in sync coverage."
    );
    fs.writeFileSync(
      skippedFile,
      "## Ignored\n\nThis document should never be scanned because its directory is excluded."
    );
    fs.writeFileSync(
      hiddenFile,
      "## Hidden\n\nThis document should never be scanned because its directory is hidden."
    );

    const progress: string[] = [];
    const config = {
      ...makeConfig(tmpDir),
      dirs: [docsDir],
      excludeDirs: ["skip-me"],
    };
    const index = new KnowledgeIndex(
      config,
      new TestEmbedder(
        async () => {
          throw new Error("not used");
        },
        async (texts) => texts.map(() => [0.9, 0.1, 0, 0])
      )
    );

    const first = await index.sync((update) => {
      progress.push(update.phase);
      if (update.phase === "queue") {
        throw new Error("observer failure should be ignored");
      }
    });

    assert.deepStrictEqual(first, { added: 1, updated: 0, removed: 0 });
    assert.ok(progress.includes("scan"));
    assert.ok(progress.includes("queue"));
    assert.ok(progress.includes("embed"));
    assert.ok(progress.includes("upsert"));
    assert.equal(index.size(), 1);

    fs.rmSync(keptFile, { force: true });
    const second = await index.sync();
    assert.deepStrictEqual(second, { added: 0, updated: 0, removed: 1 });
    assert.equal(index.size(), 0);
  });

  it("supports explicit remove, delete alias, reset, and rebuild", async () => {
    const docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    const filePath = path.join(docsDir, "note.md");
    fs.writeFileSync(
      filePath,
      "## Note\n\nThis document exists so rebuild and reset paths have content to index and remove."
    );

    const index = new KnowledgeIndex(
      {
        ...makeConfig(tmpDir),
        dirs: [docsDir],
      },
      new TestEmbedder(
        async () => [1, 0, 0, 0],
        async (texts) => texts.map(() => [1, 0, 0, 0])
      )
    );

    await index.rebuild();
    assert.equal(index.size(), 1);

    index.deleteFile(filePath);
    assert.equal(index.size(), 0);

    await index.rebuild();
    assert.equal(index.size(), 1);

    const phases: string[] = [];
    await index.reset((progress) => phases.push(progress.phase));
    assert.deepStrictEqual(phases, ["init"]);
    assert.equal(index.size(), 0);
    assert.equal(index.chunkCount(), 0);
  });

  it("skips hidden path updates without touching existing data", async () => {
    const docsDir = path.join(tmpDir, "docs");
    const hiddenDir = path.join(docsDir, ".cache");
    fs.mkdirSync(hiddenDir, { recursive: true });
    const hiddenFile = path.join(hiddenDir, "secret.md");
    fs.writeFileSync(hiddenFile, "## Hidden\n\nThis should be skipped because the path is hidden and excluded.");

    const index = new KnowledgeIndex(
      makeConfig(tmpDir),
      new TestEmbedder(
        async () => {
          throw new Error("not used");
        },
        async (texts) => texts.map(() => [1, 0, 0, 0])
      )
    );
    const internal = index as unknown as { data: IndexData };
    internal.data.entries["/existing.md#0"] = {
      relPath: "existing.md",
      sourceDir: "/vault",
      mtime: 1,
      vector: [1, 0, 0, 0],
      excerpt: "existing",
      heading: "intro",
      chunkIndex: 0,
    };

    await index.updateFile(hiddenFile, docsDir);
    assert.deepStrictEqual(Object.keys(internal.data.entries), ["/existing.md#0"]);
  });
});