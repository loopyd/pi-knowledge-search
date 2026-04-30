#!/usr/bin/env node
import { loadConfig } from "./config";
import { createEmbedder } from "./embedder";
import { KnowledgeIndex } from "./index-store";
import {
  getKnowledgeSearchLogPath,
  logError,
  logInfo,
} from "./logging";

// Report uncaught errors back to parent before exiting
process.on("uncaughtException", (err) => {
  logError("sync-worker", "uncaught exception", {
    message: err.message,
    stack: err.stack,
  });
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("sync-worker", "unhandled rejection", {
    reason: String(reason),
  });
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}\n`);
  process.exit(1);
});

logInfo("sync-worker", "startup", {
  pid: process.pid,
  configPath: process.env.KNOWLEDGE_SEARCH_CONFIG,
  logPath: getKnowledgeSearchLogPath(),
});

const config = loadConfig();
if (!config) {
  logInfo("sync-worker", "no config loaded; exiting without sync");
  process.exit(0);
}

logInfo("sync-worker", "config loaded", {
  hasProvider: Boolean(config.provider),
  providerType: config.provider?.type,
  dimensions: config.dimensions,
  dirCount: config.dirs.length,
  kbCount: config.knowledgeBases.length,
});

const embedder = createEmbedder(config.provider, config.dimensions);
const index = new KnowledgeIndex(config, embedder);
index.loadSync();

const syncStartedAt = Date.now();

index.sync().then(({ added, updated, removed }) => {
  const result = JSON.stringify({ added, updated, removed, size: index.size(), chunks: index.chunkCount() });
  logInfo("sync-worker", "sync completed", {
    added,
    updated,
    removed,
    size: index.size(),
    chunks: index.chunkCount(),
    durationMs: Date.now() - syncStartedAt,
    resultLength: result.length,
  });
  process.stdout.write(result);
  process.exit(0);
}).catch((err) => {
  logError("sync-worker", "sync failed", {
    message: err.message,
    stack: err.stack,
    durationMs: Date.now() - syncStartedAt,
  });
  process.stderr.write(err.message);
  process.exit(1);
});
