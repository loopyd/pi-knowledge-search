#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { KnowledgeIndex } from "./index-store.js";
import type { Config, KnowledgeSearchProgressMessage } from "./types.js";

const DEBUG_WORKER = process.env.KNOWLEDGE_SEARCH_DEBUG_WORKER === "1";

function debugWorker(message: string): void {
  if (!DEBUG_WORKER) return;
  process.stderr.write(`knowledge-search worker debug: ${message}\n`);
}

// Report uncaught errors back to parent before exiting
process.on("uncaughtException", (err) => {
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}\n`);
  process.exit(1);
});

function loadRuntimeConfig(): Config | null {
  const raw = process.env.KNOWLEDGE_SEARCH_RUNTIME_CONFIG;
  if (!raw) {
    debugWorker("runtime config env missing; falling back to loadConfig()")
    return loadConfig();
  }

  try {
    debugWorker("using runtime config env payload");
    return JSON.parse(raw) as Config;
  } catch (err) {
    process.stderr.write(
      `knowledge-search worker runtime config parse failed: ${(err as Error).message}\n`
    );
    return loadConfig();
  }
}

const config = loadRuntimeConfig();
debugWorker(
  `resolved config provider=${config?.provider?.type ?? "none"} dirs=${config?.dirs.length ?? 0} indexDir=${config?.indexDir ?? "none"}`
);
if (!config || !config.provider) {
  debugWorker("exiting early because config or provider is missing");
  process.exit(0);
}

const embedder = createEmbedder(config.provider, config.dimensions);
const index = new KnowledgeIndex(config, embedder);
await index.load();
debugWorker(`loaded index reindexState=${index.reindex()}`);
debugWorker("starting sync()");

index
  .sync((progress) => {
    if (typeof process.send === "function") {
      const message: KnowledgeSearchProgressMessage = {
        type: "knowledge-search-progress",
        progress,
      };
      process.send(message);
    }
  })
  .then(({ added, updated, removed }) => {
    debugWorker(`sync resolved added=${added} updated=${updated} removed=${removed}`);
    const result = JSON.stringify({
      added,
      updated,
      removed,
      size: index.size(),
      chunks: index.chunkCount(),
    });
    process.stdout.write(result);
    process.exit(0);
  })
  .catch((err) => {
    debugWorker(`sync rejected: ${(err as Error).message}`);
    process.stderr.write(err.message);
    process.exit(1);
  });
