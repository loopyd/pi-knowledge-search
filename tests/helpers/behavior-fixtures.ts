import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeIndex } from "../../src/index-store.js";
import type { Config, KbAdapter } from "../../src/types.js";
import { adapterLocalPath } from "./adapter-fixtures.js";
import { makeTestConfig, StubEmbedder } from "./index-fixtures.js";

export type SessionAction =
  | { type: "send"; text: string }
  | { type: "sleep"; seconds: number }
  | { type: "wait_log"; markers: string[]; timeout: number; failMarkers?: string[] }
  | { type: "wait_path"; path: string; exists: boolean; timeout: number }
  | { type: "wait_line_count"; path: string; minimumLines: number; timeout: number }
  | { type: "wait_http_number"; url: string; field: string; minimum: number; timeout: number };

export type StoredEntry = {
  relPath: string;
  sourceDir: string;
  mtime: number;
  vector: number[];
  excerpt: string;
  heading?: string;
  chunkIndex: number;
};

export type IndexSnapshot = {
  chunkCount: number;
  size: number;
  reindexState: "running" | "paused";
  entries: Record<string, StoredEntry>;
};

type FakeEmbeddingServer = {
  baseUrl: string;
  statsUrl: string;
  requestCount: () => number;
  close: () => Promise<void>;
};

export type Scenario = {
  adapter: KbAdapter;
  workspaceRoot: string;
  tempRoot: string;
  homeDir: string;
  docsDir: string;
  configPath: string;
  indexPath: string;
  legacyPath: string;
  pidFile: string;
  config: Config;
  server: FakeEmbeddingServer;
};

export type SeedMode = "paused-current" | "legacy-v2" | "legacy-v3";

export type ScenarioOptions = {
  adapter?: KbAdapter;
  seedMode?: SeedMode;
  serverDelayMs?: number;
};

export type BehavioralRuntime = {
  packageRoot: string;
  workspaceRoot: string | null;
  helperScript: string;
  pythonBin: string | null;
  piBin: string | null;
  unsetEnv: string[];
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function createScenario(prefix: string, options: ScenarioOptions = {}): Promise<Scenario> {
  const { adapter = "jsonl_v4", seedMode = "paused-current", serverDelayMs = 1000 } = options;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const homeDir = path.join(tempRoot, "home");
  const docsDir = path.join(tempRoot, "docs");
  const indexDir = path.join(tempRoot, "knowledge-search");
  const configDir = path.join(tempRoot, ".pi");
  const globalAgentDir = path.join(homeDir, ".pi", "agent");

  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(globalAgentDir, { recursive: true });

  createCorpus(docsDir);

  const server = await startFakeEmbeddingServer(serverDelayMs, 4);
  const config = makeTestConfig(indexDir, {
    adapter,
    dirs: [docsDir],
    provider: {
      type: "openai-compatible",
      baseUrl: server.baseUrl,
      apiKey: "test-key",
      model: "test-model",
    },
  });
  const configPath = path.join(configDir, "knowledge-search.json");
  const settingsPath = path.join(configDir, "settings.json");
  const globalSettingsPath = path.join(globalAgentDir, "settings.json");
  const globalModelsPath = path.join(globalAgentDir, "models.json");
  const sourceModelsPath = path.join(process.env.HOME ?? os.homedir(), ".pi", "agent", "models.json");
  const legacyPath = adapterLocalPath(indexDir, "json_v3");

  const settings = {
    project: {
      name: prefix,
      cwd: tempRoot,
    },
    defaultProvider: "llama-cpp-local",
    defaultModel: "qwen3-chat",
    defaultThinkingLevel: "high",
    quietStartup: true,
    transport: "sse",
    extensions: [path.join(packageRoot, "src", "index.ts")],
  };

  const globalSettings = {
    defaultProvider: "llama-cpp-local",
    defaultModel: "qwen3-chat",
    defaultThinkingLevel: "high",
    quietStartup: true,
    packages: [],
  };

  if (fs.existsSync(sourceModelsPath)) {
    fs.copyFileSync(sourceModelsPath, globalModelsPath);
  }
  fs.writeFileSync(globalSettingsPath, JSON.stringify(globalSettings, null, 2));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  if (seedMode === "paused-current") {
    await seedPausedIndex(config, docsDir);
  } else if (seedMode === "legacy-v2") {
    seedLegacyV2Index(legacyPath, docsDir);
  } else {
    seedLegacyV3Index(legacyPath, docsDir);
  }

  return {
    adapter,
    workspaceRoot: tempRoot,
    tempRoot,
    homeDir,
    docsDir,
    configPath,
    indexPath: fileURLToPath(config.kbAdapterSourceUri),
    legacyPath,
    pidFile: path.join(indexDir, "sync-worker.pid"),
    config,
    server,
  };
}

export async function cleanupScenario(scenario: Scenario): Promise<void> {
  await scenario.server.close();
  fs.rmSync(scenario.tempRoot, { recursive: true, force: true });
}

export async function loadIndexSnapshot(config: Config): Promise<IndexSnapshot> {
  const index = new KnowledgeIndex(config, new StubEmbedder("not used in behavioral tests"));
  await index.load();

  const internal = index as unknown as {
    data: {
      reindexState: "running" | "paused";
      entries: Record<string, StoredEntry>;
    };
  };

  try {
    return {
      chunkCount: index.chunkCount(),
      size: index.size(),
      reindexState: internal.data.reindexState,
      entries: internal.data.entries,
    };
  } finally {
    await index.close();
  }
}

export async function runPiSession(
  runtime: BehavioralRuntime,
  scenario: Scenario,
  name: string,
  actions: SessionAction[]
): Promise<void> {
  assert.ok(runtime.workspaceRoot, "workspace root is required for behavioral tests");
  assert.ok(runtime.piBin, "pi binary is required for behavioral tests");
  assert.ok(runtime.pythonBin, "python3 is required for behavioral tests");

  const specPath = path.join(scenario.tempRoot, `${name}-session.json`);
  const spec = {
    cwd: scenario.workspaceRoot,
    piBin: runtime.piBin,
    sessionLog: path.join(scenario.tempRoot, `${name}.log`),
    unsetEnv: runtime.unsetEnv,
    env: {
      HOME: scenario.homeDir,
    },
    actions,
  };

  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

  const child = spawn(runtime.pythonBin, [runtime.helperScript, specPath], {
    cwd: runtime.packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );

  assert.equal(result.code, 0, stderr || stdout || `session helper exited with signal ${result.signal}`);
  assert.ok(stdout.trim().length > 0, "expected PTY helper to emit a JSON summary");
}

export function pauseActions(scenario: Scenario): SessionAction[] {
  return [
    {
      type: "wait_log",
      markers: [scenario.workspaceRoot],
      timeout: 60,
    },
    {
      type: "send",
      text: "/knowledge-reindex-start\r",
    },
    {
      type: "wait_log",
      markers: ["Re-index started in background. Use /knowledge-reindex-stop to pause."],
      failMarkers: ["Re-index start failed:", "Not configured. Run /knowledge-search-setup first."],
      timeout: 60,
    },
    {
      type: "wait_path",
      path: scenario.pidFile,
      exists: true,
      timeout: 60,
    },
    {
      type: "wait_http_number",
      url: scenario.server.statsUrl,
      field: "requestCount",
      minimum: 1,
      timeout: 60,
    },
    {
      type: "send",
      text: "/knowledge-reindex-stop\r",
    },
    {
      type: "wait_log",
      markers: ["Re-index paused. Use /knowledge-reindex-start to resume."],
      failMarkers: ["Re-index stop failed:"],
      timeout: 60,
    },
    {
      type: "wait_path",
      path: scenario.pidFile,
      exists: false,
      timeout: 60,
    },
    {
      type: "sleep",
      seconds: 5.5,
    },
  ];
}

export function syncActions(scenario: Scenario): SessionAction[] {
  return [
    {
      type: "wait_log",
      markers: [scenario.workspaceRoot],
      timeout: 60,
    },
    {
      type: "send",
      text: "/knowledge-reindex-start\r",
    },
    {
      type: "wait_log",
      markers: [
        "Re-index started in background. Use /knowledge-reindex-stop to pause.",
        "KB init",
        "Index:",
      ],
      failMarkers: ["Re-index start failed:", "Not configured. Run /knowledge-search-setup first."],
      timeout: 60,
    },
    {
      type: "wait_http_number",
      url: scenario.server.statsUrl,
      field: "requestCount",
      minimum: 1,
      timeout: 60,
    },
    {
      type: "wait_path",
      path: scenario.pidFile,
      exists: false,
      timeout: 120,
    },
    {
      type: "sleep",
      seconds: 0.5,
    },
  ];
}

function createCorpus(docsDir: string): void {
  fs.writeFileSync(
    path.join(docsDir, "seed.md"),
    ["# Seed", "", "This file should be refreshed after resume.", "", "resume target ".repeat(24)].join("\n")
  );

  for (let indexValue = 0; indexValue < 12; indexValue += 1) {
    const body = [
      `# Doc ${indexValue}`,
      "",
      `This is behavioral sync document ${indexValue}.`,
      "",
      "knowledge search behavioral resume test ".repeat(18),
    ].join("\n");
    fs.writeFileSync(path.join(docsDir, `doc-${String(indexValue).padStart(3, "0")}.md`), body);
  }
}

async function startFakeEmbeddingServer(delayMs: number, dimensions: number): Promise<FakeEmbeddingServer> {
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ requestCount }));
      return;
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }));
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requestCount += 1;

      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const rawInput = Array.isArray(payload.input) ? payload.input : [payload.input];
      const data = rawInput.map((value: unknown, indexValue: number) => {
        const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
        return {
          object: "embedding",
          index: indexValue,
          embedding: Array.from({ length: dimensions }, (_, dimension) =>
            Number((text.length + indexValue + dimension + 1).toFixed(6))
          ),
        };
      });

      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data,
            model: payload.model ?? "test-model",
            usage: { prompt_tokens: rawInput.length, total_tokens: rawInput.length },
          })
        );
      }, delayMs);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    statsUrl: `http://127.0.0.1:${address.port}/__stats`,
    requestCount: () => requestCount,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function seedPausedIndex(config: Config, docsDir: string): Promise<void> {
  const index = new KnowledgeIndex(config, new StubEmbedder("not used in behavioral tests"));
  const internal = index as unknown as {
    data: {
      reindexState: "running" | "paused";
      entries: Record<string, StoredEntry>;
    };
    save: () => Promise<void>;
  };

  internal.data.reindexState = "paused";
  internal.data.entries[`${docsDir}/seed.md#0`] = {
    relPath: "seed.md",
    sourceDir: docsDir,
    mtime: 1_700_000_000_000,
    vector: [1, 0, 0, 0],
    excerpt: "seeded excerpt",
    heading: "seed",
    chunkIndex: 0,
  };

  await internal.save();
}

function seedLegacyV2Index(indexPath: string, docsDir: string): void {
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 2,
      dimensions: 4,
      entries: {
        [path.join(docsDir, "seed.md")]: {
          relPath: "seed.md",
          sourceDir: docsDir,
          mtime: 1_700_000_000_000,
          vector: [1, 0, 0, 0],
          excerpt: "legacy v2 excerpt",
        },
      },
    })
  );
}

function seedLegacyV3Index(indexPath: string, docsDir: string): void {
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      version: 3,
      dimensions: 4,
      entries: {
        [`${path.join(docsDir, "seed.md")}#0`]: {
          relPath: "seed.md",
          sourceDir: docsDir,
          mtime: 1_700_000_000_000,
          vector: [1, 0, 0, 0],
          excerpt: "legacy v3 excerpt",
          heading: "intro",
          chunkIndex: 0,
        },
      },
    })
  );
}