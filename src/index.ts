import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import { BedrockAdapter } from "./adapters/index.js";
import { createEmbedder } from "./embedder.js";
import { KnowledgeIndex } from "./index-store.js";
import { SyncController } from "./sync-controller.js";
import { FileWatcher } from "./watcher.js";
import type {
  BedrockKnowledgeBaseDataSourceType,
  KnowledgeBaseConfig,
  BedrockKnowledgeBaseSyncMode,
  BedrockKnowledgeBaseSyncResult,
  Config,
  ConfigFile,
} from "./types.js";

export default function (pi: ExtensionAPI) {
  let index: KnowledgeIndex | null = null;
  let kbSearcher: BedrockAdapter | null = null;
  let watcher: FileWatcher | null = null;
  let currentConfig: Config | null = null;
  const syncController = SyncController.shared();

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    index = null;
    kbSearcher = null;
    watcher = null;
    try {
      currentConfig = loadConfig();
    } catch {
      return;
    }
    if (!currentConfig) return;

    if (currentConfig.provider) {
      const embedder = createEmbedder(currentConfig.provider, currentConfig.dimensions);
      index = new KnowledgeIndex(currentConfig, embedder);
      await index.load();
      watcher = new FileWatcher(currentConfig, index);
    }

    if (currentConfig.knowledgeBases.length > 0) {
      kbSearcher = new BedrockAdapter(currentConfig.knowledgeBases);
    }

    await syncController.start({
      config: currentConfig,
      index,
      ctx,
      realtime: watcher,
    });
  });

  pi.on("session_shutdown", async () => {
    await syncController.stop();
    watcher?.stop();
    await kbSearcher?.close?.();
    await index?.close();
  });

  // ------------------------------------------------------------------
  // Setup command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-search-setup", {
    description: "Configure knowledge search directories and embedding provider",
    handler: async (_args, ctx) => {
      // Step 1: Directories
      const dirsInput = await ctx.ui.input(
        "Directories to index (comma-separated):",
        "~/notes, ~/docs"
      );
      if (!dirsInput) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const dirs = dirsInput
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);

      if (dirs.length === 0) {
        ctx.ui.notify("No directories specified.", "warning");
        return;
      }

      // Step 2: File extensions
      const extsInput = await ctx.ui.input("File extensions to index:", ".md, .txt");
      const fileExtensions = (extsInput || ".md, .txt")
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);

      // Step 3: Exclude directories
      const excludeInput = await ctx.ui.input(
        "Directory names to exclude:",
        "node_modules, .git, .obsidian, .trash"
      );
      const excludeDirs = (excludeInput || "node_modules, .git, .obsidian, .trash")
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);

      // Step 4: Provider
      const providerChoice = await ctx.ui.select("Embedding provider:", [
        "openai — OpenAI API (text-embedding-3-small)",
        "bedrock — AWS Bedrock (Titan Embeddings v2)",
        "ollama — Local Ollama (nomic-embed-text)",
      ]);

      if (!providerChoice) {
        ctx.ui.notify("Setup cancelled.", "info");
        return;
      }

      const providerType = providerChoice.split(" ")[0] as "openai" | "bedrock" | "ollama";

      let configFile: ConfigFile;

      switch (providerType) {
        case "openai": {
          const apiKey = await ctx.ui.input(
            "OpenAI API key (or env var name):",
            process.env.OPENAI_API_KEY ? "(using OPENAI_API_KEY from env)" : ""
          );
          const model = await ctx.ui.input("Model:", "text-embedding-3-small");
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            kbAdapter: "jsonl_v4",
            provider: {
              type: "openai",
              apiKey: apiKey?.startsWith("(") ? undefined : apiKey || undefined,
              model: model || "text-embedding-3-small",
            },
          };
          break;
        }
        case "bedrock": {
          const profile = await ctx.ui.input("AWS profile:", "default");
          const region = await ctx.ui.input("AWS region:", "us-east-1");
          const model = await ctx.ui.input("Model:", "amazon.titan-embed-text-v2:0");
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            kbAdapter: "jsonl_v4",
            provider: {
              type: "bedrock",
              profile: profile || "default",
              region: region || "us-east-1",
              model: model || "amazon.titan-embed-text-v2:0",
            },
          };
          break;
        }
        case "ollama": {
          const url = await ctx.ui.input("Ollama URL:", "http://localhost:11434");
          const model = await ctx.ui.input("Model:", "nomic-embed-text");
          configFile = {
            dirs,
            fileExtensions,
            excludeDirs,
            kbAdapter: "jsonl_v4",
            provider: {
              type: "ollama",
              url: url || "http://localhost:11434",
              model: model || "nomic-embed-text",
            },
          };
          break;
        }
      }

      // Save and confirm
      saveConfig(configFile!);
      ctx.ui.notify(`Config saved to ${getConfigPath()}. Run /reload to activate.`, "info");
    },
  });

  // ------------------------------------------------------------------
  // Add Knowledge Base command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-bedrock-setup", {
    description: "Add a Bedrock Knowledge Base as a search source",
    handler: async (_args, ctx) => {
      const kbId = await ctx.ui.input("Bedrock Knowledge Base ID:", "");
      if (!kbId) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const label = await ctx.ui.input("Label (optional, for display):", "");

      const region = await ctx.ui.input("AWS region:", "us-east-1");

      const profile = await ctx.ui.input("AWS profile:", "default");

      const syncChoice = await ctx.ui.select("Bedrock sync mode:", [
        "search - query an existing knowledge base only",
        "direct - push local files into a custom data source",
        "ingestion_job - ask Bedrock to sync a staged data source",
      ]);

      if (!syncChoice) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const syncMode = syncChoice.split(" ")[0] as BedrockKnowledgeBaseSyncMode;
      let dataSourceId: string | undefined;
      let dataSourceType: BedrockKnowledgeBaseDataSourceType | undefined;

      if (syncMode !== "search") {
        dataSourceId = await ctx.ui.input("Bedrock data source ID:", "");
        if (!dataSourceId) {
          ctx.ui.notify("Cancelled.", "info");
          return;
        }

        const dataSourceChoice = await ctx.ui.select("Bedrock data source type:", [
          "custom - direct document API support",
          "s3 - staged S3 data source",
        ]);

        if (!dataSourceChoice) {
          ctx.ui.notify("Cancelled.", "info");
          return;
        }

        dataSourceType = dataSourceChoice.split(" ")[0] as BedrockKnowledgeBaseDataSourceType;
      }

      // Load existing config or create minimal one
      let existing: ConfigFile;
      try {
        const loaded = loadConfig();
        if (loaded) {
          // Read the raw file to preserve structure
          const raw = fs.readFileSync(getConfigPath(), "utf-8");
          existing = JSON.parse(raw);
        } else {
          existing = {};
        }
      } catch {
        existing = {};
      }

      if (!existing.knowledgeBases) existing.knowledgeBases = [];

      // Don't add duplicates
      if (existing.knowledgeBases.some((kb: any) => kb.id === kbId)) {
        ctx.ui.notify(`KB ${kbId} already configured.`, "warning");
        return;
      }

      existing.knowledgeBases.push({
        id: kbId,
        region: region || "us-east-1",
        profile: profile || "default",
        syncMode,
        ...(label ? { label } : {}),
        ...(dataSourceId ? { dataSourceId } : {}),
        ...(dataSourceType ? { dataSourceType } : {}),
      });

      saveConfig(existing as ConfigFile);
      ctx.ui.notify(
        `Added KB ${kbId}${label ? ` (${label})` : ""}. Run /reload to activate.`,
        "info"
      );
    },
  });

  pi.registerCommand("knowledge-bedrock-sync", {
    description: "Sync configured Bedrock knowledge base data sources",
    handler: async (_args, ctx) => {
      if (!currentConfig || !kbSearcher || currentConfig.knowledgeBases.length === 0) {
        ctx.ui.notify("No Bedrock knowledge bases are active. Run /knowledge-add-kb first.", "warning");
        return;
      }

      const results = await kbSearcher.sync(currentConfig);
      const failures = results.filter((result) => result.status === "FAILED");

      ctx.ui.notify(formatKnowledgeBaseSyncResults(results), failures.length > 0 ? "warning" : "info");
    },
  });

  pi.registerCommand("knowledge-bedrock-status", {
    description: "Show the current Bedrock knowledge base configuration",
    handler: async (_args, ctx) => {
      let configured = currentConfig;

      try {
        configured = loadConfig();
      } catch {
        // Fall back to the active in-memory config if the file cannot be read.
      }

      if (!configured || configured.knowledgeBases.length === 0) {
        ctx.ui.notify("No Bedrock knowledge bases are configured. Run /knowledge-add-kb first.", "warning");
        return;
      }

      ctx.ui.notify(
        formatKnowledgeBaseStatus(configured.knowledgeBases, currentConfig?.knowledgeBases ?? []),
        "info"
      );
    },
  });

  // ------------------------------------------------------------------
  // Reindex command
  // ------------------------------------------------------------------

  pi.registerCommand("knowledge-reindex-start", {
    description: "Start or resume knowledgebase re-indexing without clearing existing index state",
    handler: async (_args, ctx) => {
      if (!index || !currentConfig) {
        ctx.ui.notify("Not configured. Run /knowledge-search-setup first.", "warning");
        return;
      }

      ctx.ui.notify("Starting or resuming re-index...", "info");
      try {
        index.reindex("running");
        await syncController.start(
          {
            config: currentConfig,
            index,
            ctx,
            realtime: watcher,
          },
          { respectPausedState: false }
        );

        ctx.ui.notify("Re-index started in background. Use /knowledge-reindex-stop to pause.", "info");
      } catch (err: any) {
        ctx.ui.notify(`Re-index start failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("knowledge-reindex-stop", {
    description: "Pause knowledgebase re-indexing and keep checkpoint state for resume",
    handler: async (_args, ctx) => {
      try {
        await syncController.pause(ctx);
        ctx.ui.notify("Re-index paused. Use /knowledge-reindex-start to resume.", "info");
      } catch (err: any) {
        ctx.ui.notify(`Re-index stop failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("knowledge-reindex-restart", {
    description: "Restart knowledgebase re-indexing from a fresh index state",
    handler: async (_args, ctx) => {
      if (!index || !currentConfig) {
        ctx.ui.notify("Not configured. Run /knowledge-search-setup first.", "warning");
        return;
      }

      ctx.ui.notify("Restarting re-index from a clean index state...", "info");
      try {
        await syncController.restart({
          config: currentConfig,
          index,
          ctx,
          realtime: watcher,
        });

        ctx.ui.notify(
          "Re-index restarted from a fresh index. Use /knowledge-reindex-stop to pause.",
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`Re-index restart failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("knowledge-reindex", {
    description: "Alias for /knowledge-reindex-restart",
    handler: async (_args, ctx) => {
      if (!index || !currentConfig) {
        ctx.ui.notify("Not configured. Run /knowledge-search-setup first.", "warning");
        return;
      }

      ctx.ui.notify("Restarting re-index from a clean index state...", "info");
      try {
        await syncController.restart({
          config: currentConfig,
          index,
          ctx,
          realtime: watcher,
        });
        ctx.ui.notify(
          "Re-index restarted from a fresh index. Use /knowledge-reindex-stop to pause.",
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`Re-index restart failed: ${err.message}`, "error");
      }
    },
  });

  // ------------------------------------------------------------------
  // Search tool
  // ------------------------------------------------------------------

  const searchParams = Type.Object({
    query: Type.String({ description: "Natural language search query" }),
    limit: Type.Optional(
      Type.Number({
        description: "Max results to return (default 8, max 20)",
      })
    ),
  });
  type SearchDetails = { resultCount?: number; indexSize?: number };

  pi.registerTool<typeof searchParams, SearchDetails>({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Semantic search over local knowledge files. Returns the most relevant file excerpts for a natural language query. Use for finding past notes, investigations, decisions, documentation, and context. Prefer this over grep when you need conceptual or fuzzy matching rather than exact text.",
    promptGuidelines: [
      'Use knowledge_search for conceptual queries (e.g. "how did we handle X", "what was decided about Y"). Use grep/read for exact text or known filenames.',
    ],
    parameters: searchParams,
    async execute(toolCallId, params, signal) {
      const hasLocalIndex = index && index.size() > 0;
      const hasKB = !!kbSearcher;

      if (!hasLocalIndex && !hasKB) {
        const msg =
          !index && !kbSearcher
            ? "knowledge-search is not configured. The user can run /knowledge-search-setup to set it up."
            : !syncController.done() && index
              ? "Index is still syncing in the background. Try again in a moment."
              : "Index is empty.";
        return { content: [{ type: "text", text: msg }], details: {} };
      }

      const limit = Math.min(params.limit ?? 8, 20);

      try {
        const [localResults, kbResults] = await Promise.all([
          hasLocalIndex ? index!.search(params.query, limit, signal) : [],
          hasKB ? kbSearcher!.search(params.query, limit, undefined, signal) : [],
        ]);

        // Merge and sort by score, take top N
        const results = [...localResults, ...kbResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No relevant results found for: "${params.query}"`,
              },
            ],
            details: {},
          };
        }

        const home = process.env.HOME || "";
        const output = results
          .map((r: any, i: number) => {
            const displayPath = r.path.replace(home, "~");
            const score = (r.score * 100).toFixed(1);
            const heading = r.heading && r.heading !== "intro" ? ` > ${r.heading}` : "";
            return `### ${i + 1}. ${displayPath}${heading} (${score}% match)\n\n${r.excerpt}`;
          })
          .join("\n\n---\n\n");

        const indexInfo = hasLocalIndex
          ? `${index!.size()} files, ${index!.chunkCount()} chunks indexed`
          : "";
        const kbInfo = hasKB ? `${currentConfig!.knowledgeBases.length} knowledge base(s)` : "";
        const sourceInfo = [indexInfo, kbInfo].filter(Boolean).join(" + ");
        const header = `Found ${results.length} results for "${params.query}" (${sourceInfo}):\n\n`;

        return {
          content: [{ type: "text", text: header + output }],
          details: { resultCount: results.length, indexSize: index?.size() ?? 0 },
        };
      } catch (err: any) {
        throw new Error(`knowledge-search failed: ${err.message}`);
      }
    },
  });
}

function formatKnowledgeBaseSyncResults(results: BedrockKnowledgeBaseSyncResult[]): string {
  return results
    .map((result) => {
      const label = result.label ? `${result.label} (${result.knowledgeBaseId})` : result.knowledgeBaseId;
      const count = result.documentCount != null ? `, docs=${result.documentCount}` : "";
      const failed = result.failedDocumentCount ? `, failed=${result.failedDocumentCount}` : "";
      const job = result.jobId ? `, job=${result.jobId}` : "";
      const detail = result.details ? `, ${result.details}` : "";
      const documentFailures = formatKnowledgeBaseDocumentFailures(result);
      return `${label}: ${result.status}${count}${failed}${job}${detail}${documentFailures}`;
    })
    .join("\n");
}

function formatKnowledgeBaseDocumentFailures(result: BedrockKnowledgeBaseSyncResult): string {
  if (!result.documentFailures || result.documentFailures.length === 0) {
    return "";
  }

  const limit = 5;
  const lines = result.documentFailures.slice(0, limit).map((failure) => {
    const reason = failure.reason ? `: ${failure.reason}` : "";
    return `\n  - ${failure.operation} ${failure.identifier} [${failure.status}]${reason}`;
  });

  if (result.documentFailures.length > limit) {
    lines.push(`\n  - ... ${result.documentFailures.length - limit} more document failure(s)`);
  }

  return lines.join("");
}

function formatKnowledgeBaseStatus(
  configured: KnowledgeBaseConfig[],
  active: KnowledgeBaseConfig[]
): string {
  const activeConfigs = new Set(active.map((entry) => knowledgeBaseSignature(entry)));

  return configured
    .map((entry) => {
      const label = entry.label ? `${entry.label} (${entry.id})` : entry.id;
      const loaded = activeConfigs.has(knowledgeBaseSignature(entry)) ? "active" : "saved";
      const source = entry.dataSourceId
        ? `, source=${entry.dataSourceType ?? "unknown"}/${entry.dataSourceId}`
        : "";
      const syncTuning =
        entry.syncMode === "direct"
          ? `, batch=${entry.ingestBatchSize}`
          : entry.syncMode === "ingestion_job"
            ? `, poll=${entry.pollIntervalMs}ms, wait=${entry.maxWaitMs}ms`
            : "";

      return `${label}: ${loaded}, mode=${entry.syncMode}, region=${entry.region}, profile=${entry.profile}${source}${syncTuning}`;
    })
    .join("\n");
}

function knowledgeBaseSignature(entry: KnowledgeBaseConfig): string {
  return [
    entry.id,
    entry.label ?? "",
    entry.region,
    entry.profile,
    entry.syncMode,
    entry.dataSourceId ?? "",
    entry.dataSourceType ?? "",
    String(entry.ingestBatchSize),
    String(entry.pollIntervalMs),
    String(entry.maxWaitMs),
  ].join("|");
}
