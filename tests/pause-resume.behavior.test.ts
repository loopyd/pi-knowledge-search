import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  BehavioralRuntime,
  IndexSnapshot,
  SeedMode,
} from "./helpers/behavior-fixtures.js";
import {
  cleanupScenario,
  createScenario,
  loadIndexSnapshot,
  pauseActions,
  runPiSession,
  syncActions,
} from "./helpers/behavior-fixtures.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = findWorkspaceRoot(packageRoot);
const helperScript = path.join(packageRoot, "tests", "helpers", "pi-session-driver.py");
const pythonBin = resolveCommand(process.env.PI_BEHAVIORAL_PYTHON_BIN ?? "python3", ["--version"]);
const piBin = resolvePiBin(workspaceRoot);
const shouldRunBehavioral =
  process.env.RUN_PI_BEHAVIORAL_TESTS === "1" &&
  workspaceRoot !== null &&
  pythonBin !== null &&
  piBin !== null &&
  fs.existsSync(helperScript);
const describeBehavioral = shouldRunBehavioral ? describe : describe.skip;

const unsetKnowledgeSearchEnv = [
  "KB_ADAPTER",
  "KB_ADAPTER_SOURCE_URI",
  "KNOWLEDGE_SEARCH_KB_ADAPTER",
  "KNOWLEDGE_SEARCH_KB_ADAPTER_SOURCE_URI",
  "KNOWLEDGE_SEARCH_CONFIG",
  "KNOWLEDGE_SEARCH_DIRS",
  "KNOWLEDGE_SEARCH_EXTENSIONS",
  "KNOWLEDGE_SEARCH_EXCLUDE",
  "KNOWLEDGE_SEARCH_DIMENSIONS",
  "KNOWLEDGE_SEARCH_PROVIDER",
  "KNOWLEDGE_SEARCH_OPENAI_API_KEY",
  "KNOWLEDGE_SEARCH_OPENAI_MODEL",
  "KNOWLEDGE_SEARCH_COMPAT_API_KEY",
  "KNOWLEDGE_SEARCH_COMPAT_BASE_URL",
  "KNOWLEDGE_SEARCH_COMPAT_MODEL",
  "KNOWLEDGE_SEARCH_INDEX_DIR",
  "OPENAI_API_KEY",
];

const behavioralRuntime: BehavioralRuntime = {
  packageRoot,
  workspaceRoot,
  helperScript,
  pythonBin,
  piBin,
  unsetEnv: unsetKnowledgeSearchEnv,
};

const writableBehaviorAdapters = [
  { adapter: "jsonl_v4" as const, label: "jsonl_v4" },
  { adapter: "json_v3" as const, label: "json_v3" },
  { adapter: "sqlite_local" as const, label: "sqlite_local" },
];

const migrationCases = [
  {
    adapter: "json_v3" as const,
    label: "json_v3",
    seedMode: "legacy-v2" as const,
  },
  {
    adapter: "jsonl_v4" as const,
    label: "jsonl_v4",
    seedMode: "legacy-v2" as const,
  },
  {
    adapter: "jsonl_v4" as const,
    label: "jsonl_v4",
    seedMode: "legacy-v3" as const,
  },
  {
    adapter: "sqlite_local" as const,
    label: "sqlite_local",
    seedMode: "legacy-v2" as const,
  },
  {
    adapter: "sqlite_local" as const,
    label: "sqlite_local",
    seedMode: "legacy-v3" as const,
  },
];

describeBehavioral("behavioral adapters and migrations", { concurrency: false }, () => {
  before(() => {
    const build = spawnSync("npm", ["run", "build:worker"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
  });

  for (const { adapter, label } of writableBehaviorAdapters) {
    it(
      `${label} pauses an in-flight sync without corrupting the seeded checkpoint`,
      { timeout: 120_000 },
      async () => {
        const scenario = await createScenario(`ks-${label}-pause-behavior`, { adapter });
        try {
          await runPiSession(behavioralRuntime, scenario, "pause", pauseActions(scenario));

          const paused = await loadIndexSnapshot(scenario.config);
          assert.equal(paused.reindexState, adapter === "json_v3" ? "running" : "paused");
          assert.equal(paused.chunkCount, 1);
          assert.equal(paused.size, 1);
          assert.ok(paused.entries[`${scenario.docsDir}/seed.md#0`]);
          assert.equal(paused.entries[`${scenario.docsDir}/seed.md#0`].excerpt, "seeded excerpt");
          assert.ok(fs.existsSync(scenario.indexPath));
        } finally {
          await cleanupScenario(scenario);
        }
      }
    );

    it(
      `${label} resumes a paused sync and replaces the seeded checkpoint with synced entries`,
      { timeout: 120_000 },
      async () => {
        const scenario = await createScenario(`ks-${label}-resume-behavior`, { adapter });
        try {
          await runPiSession(behavioralRuntime, scenario, "pause", pauseActions(scenario));
          await runPiSession(behavioralRuntime, scenario, "resume", syncActions(scenario));

          const resumed = await loadIndexSnapshot(scenario.config);
          assertSyncPopulated(resumed, "seeded excerpt");
          assert.ok(fs.existsSync(scenario.indexPath));
        } finally {
          await cleanupScenario(scenario);
        }
      }
    );
  }

  for (const { adapter, label, seedMode } of migrationCases) {
    it(
      `${label} migrates ${seedMode} storage and completes a real sync`,
      { timeout: 120_000 },
      async () => {
        const scenario = await createScenario(`ks-${label}-${seedMode}-behavior`, {
          adapter,
          seedMode,
          serverDelayMs: 50,
        });
        try {
          await runPiSession(behavioralRuntime, scenario, "migrate", syncActions(scenario));

          const migrated = await loadIndexSnapshot(scenario.config);
          assertSyncPopulated(migrated, legacyExcerpt(seedMode));
          assert.ok(fs.existsSync(scenario.indexPath));

          if (adapter === "json_v3") {
            const raw = JSON.parse(fs.readFileSync(scenario.indexPath, "utf8")) as { version: number };
            assert.equal(raw.version, 3);
          } else {
            assert.ok(!fs.existsSync(scenario.legacyPath));
          }
        } finally {
          await cleanupScenario(scenario);
        }
      }
    );
  }
});

function findWorkspaceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".pi", "settings.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveCommand(command: string, probeArgs: string[]): string | null {
  const direct = spawnSync(command, probeArgs, { encoding: "utf8" });
  if (direct.status === 0) {
    return command;
  }

  const which = spawnSync("which", [command], { encoding: "utf8" });
  if (which.status === 0) {
    const resolved = which.stdout.trim();
    return resolved.length > 0 ? resolved : null;
  }

  return null;
}

function resolvePiBin(root: string | null): string | null {
  const envOverride = process.env.PI_BEHAVIORAL_PI_BIN ?? process.env.PI_BIN;
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  if (root) {
    const localBin = path.join(root, "node_modules", ".bin", "pi");
    if (fs.existsSync(localBin)) {
      return localBin;
    }
  }

  return resolveCommand("pi", ["--help"]);
}

function assertSyncPopulated(snapshot: IndexSnapshot, previousExcerpt: string): void {
  assert.ok(snapshot.chunkCount > 1);
  assert.ok(snapshot.size > 1);

  const seedEntry = Object.values(snapshot.entries).find((entry) => entry.relPath === "seed.md");
  assert.ok(seedEntry, "expected the synced index to contain seed.md entries");
  assert.notEqual(seedEntry.excerpt, previousExcerpt);

  const hasNewDocs = Object.values(snapshot.entries).some((entry) => entry.relPath === "doc-000.md");
  assert.ok(hasNewDocs, "expected sync to add newly indexed docs");
}

function legacyExcerpt(seedMode: Extract<SeedMode, "legacy-v2" | "legacy-v3">): string {
  return seedMode === "legacy-v2" ? "legacy v2 excerpt" : "legacy v3 excerpt";
}