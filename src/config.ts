import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Config,
  ConfigFile,
  KbAdapter,
  KbAdapterInput,
  KnowledgeBaseConfig,
  KnowledgeBaseConfigFile,
  ProviderConfig,
} from "./types.js";

export type { Config, ConfigFile, KbAdapter, ProviderConfig } from "./types.js";

const CONFIG_DIR_NAME = ".pi";
const CONFIG_FILENAME = "knowledge-search.json";
const SETTINGS_FILENAME = "settings.json";

interface ConfigContext {
  configPath: string;
  configDir: string;
}

let resolvedConfigContext: ConfigContext | null = null;

export function getConfigPath(): string {
  if (resolvedConfigContext) {
    return resolvedConfigContext.configPath;
  }

  const context = getConfigContext();
  resolvedConfigContext = context;
  return context.configPath;
}

/**
 * Load config from file, with env var overrides.
 * Returns null if no config file exists (needs setup).
 */
export function loadConfig(): Config | null {
  const { configPath, configDir } = getConfigContext();
  resolvedConfigContext = { configPath, configDir };

  // Try config file first
  let file: ConfigFile | null = null;
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Corrupted file
    }
  }

  // Check env var fallback for dirs
  const envDirs = process.env.KNOWLEDGE_SEARCH_DIRS;
  const envAdapterSourceUri =
    envStr("KB_ADAPTER_SOURCE_URI") ?? envStr("KNOWLEDGE_SEARCH_KB_ADAPTER_SOURCE_URI");

  const hasKBs = (file?.knowledgeBases?.length ?? 0) > 0;
  const hasAdapterSource = Boolean(envAdapterSourceUri ?? file?.kbAdapterSourceUri);

  if (!file && !envDirs) {
    return null; // Not configured yet
  }

  // Build config: file values, then env overrides
  const home = process.env.HOME || "/tmp";
  const envBaseDir = process.cwd();
  const resolveConfigPath = (value: string) => resolveLocalPath(value, configDir, home);
  const resolveEnvPath = (value: string) => resolveLocalPath(value, envBaseDir, home);

  const dirs = (envDirs ? envDirs.split(",").map((d) => d.trim()) : (file?.dirs ?? []))
    .filter(Boolean)
    .map(envDirs ? resolveEnvPath : resolveConfigPath)
    .filter(Boolean);

  if (dirs.length === 0 && !hasKBs && !hasAdapterSource) return null;

  const fileExtensions = envStr("KNOWLEDGE_SEARCH_EXTENSIONS")
    ?.split(",")
    .map((e) => e.trim()) ??
    file?.fileExtensions ?? [".md", ".txt"];

  const excludeDirs = envStr("KNOWLEDGE_SEARCH_EXCLUDE")
    ?.split(",")
    .map((d) => d.trim()) ??
    file?.excludeDirs ?? ["node_modules", ".git", ".obsidian", ".trash"];

  const dimensions = envInt("KNOWLEDGE_SEARCH_DIMENSIONS") ?? file?.dimensions ?? 512;
  const kbAdapter = normalizeKbAdapter(
    kbAdapterInput(envStr("KB_ADAPTER") ?? envStr("KNOWLEDGE_SEARCH_KB_ADAPTER") ?? file?.kbAdapter)
  );
  const envIndexDir = envStr("KNOWLEDGE_SEARCH_INDEX_DIR");
  const defaultIndexDir = envIndexDir
    ? resolveEnvPath(envIndexDir)
    : path.join(configDir, "knowledge-search");
  const kbAdapterSourceUri = normalizeKbAdapterSourceUri(
    envAdapterSourceUri ?? file?.kbAdapterSourceUri,
    kbAdapter,
    defaultIndexDir,
    home,
    envAdapterSourceUri ? envBaseDir : configDir
  );

  const providerType =
    envStr("KNOWLEDGE_SEARCH_PROVIDER") ??
    file?.provider?.type ??
    // Convenience default: if OPENAI_API_KEY is exported and nothing else
    // is configured, assume the user wants the openai provider.
    (process.env.OPENAI_API_KEY ? "openai" : undefined);

  let provider: ProviderConfig | null = null;
  if (providerType) {
    switch (providerType) {
      case "openai": {
        // Helpful migration error: if someone set a custom baseUrl on `openai`,
        // it used to be silently ignored. Steer them to openai-compatible.
        if (file?.provider?.type === "openai" && (file.provider as { baseUrl?: unknown }).baseUrl) {
          throw new Error(
            'Custom baseUrl is not supported on provider type "openai" (it would be silently ignored and requests would hit api.openai.com). Change "type" to "openai-compatible" to use a custom endpoint.'
          );
        }
        const apiKey =
          envStr("KNOWLEDGE_SEARCH_OPENAI_API_KEY") ??
          process.env.OPENAI_API_KEY ??
          (file?.provider?.type === "openai" ? file.provider.apiKey : undefined);
        if (!apiKey) {
          throw new Error(
            "OpenAI API key required. Run /knowledge-search-setup or set OPENAI_API_KEY."
          );
        }
        provider = {
          type: "openai",
          apiKey,
          model:
            envStr("KNOWLEDGE_SEARCH_OPENAI_MODEL") ??
            (file?.provider?.type === "openai" ? file.provider.model : undefined) ??
            "text-embedding-3-small",
        };
        break;
      }
      case "openai-compatible": {
        // Intentionally do NOT fall back to OPENAI_API_KEY here — an openai-
        // compatible endpoint may be a third-party service, and silently sending
        // the user's real OpenAI key to a foreign host would be a credential leak.
        // Users must set KNOWLEDGE_SEARCH_COMPAT_API_KEY explicitly (or leave
        // unset for runners like llama.cpp that don't require auth).
        const compatApiKey =
          envStr("KNOWLEDGE_SEARCH_COMPAT_API_KEY") ??
          (file?.provider?.type === "openai-compatible" ? file.provider.apiKey : undefined);
        const compatBaseUrl =
          envStr("KNOWLEDGE_SEARCH_COMPAT_BASE_URL") ??
          (file?.provider?.type === "openai-compatible" ? file.provider.baseUrl : undefined);
        if (!compatBaseUrl) {
          throw new Error(
            "OpenAI-compatible requires baseUrl. Set KNOWLEDGE_SEARCH_COMPAT_BASE_URL or provide it in your knowledge-search.json config."
          );
        }
        provider = {
          type: "openai-compatible",
          apiKey: compatApiKey,
          model:
            envStr("KNOWLEDGE_SEARCH_COMPAT_MODEL") ??
            (file?.provider?.type === "openai-compatible" ? file.provider.model : undefined) ??
            "text-embedding-3-small",
          baseUrl: compatBaseUrl,
        };
        break;
      }
      case "bedrock":
        provider = {
          type: "bedrock",
          profile:
            envStr("KNOWLEDGE_SEARCH_BEDROCK_PROFILE") ??
            (file?.provider?.type === "bedrock" ? file.provider.profile : undefined) ??
            "default",
          region:
            envStr("KNOWLEDGE_SEARCH_BEDROCK_REGION") ??
            (file?.provider?.type === "bedrock" ? file.provider.region : undefined) ??
            "us-east-1",
          model:
            envStr("KNOWLEDGE_SEARCH_BEDROCK_MODEL") ??
            (file?.provider?.type === "bedrock" ? file.provider.model : undefined) ??
            "amazon.titan-embed-text-v2:0",
        };
        break;
      case "ollama":
        provider = {
          type: "ollama",
          url:
            envStr("KNOWLEDGE_SEARCH_OLLAMA_URL") ??
            (file?.provider?.type === "ollama" ? file.provider.url : undefined) ??
            "http://localhost:11434",
          model:
            envStr("KNOWLEDGE_SEARCH_OLLAMA_MODEL") ??
            (file?.provider?.type === "ollama" ? file.provider.model : undefined) ??
            "nomic-embed-text",
        };
        break;
      default:
        throw new Error(
          `Unknown provider: "${providerType}". Use "openai", "openai-compatible", "bedrock", or "ollama".`
        );
    }
  } // end if (providerType)

  const indexDir = adapterDirectoryFromSourceUri(kbAdapterSourceUri);

  return {
    dirs,
    fileExtensions,
    excludeDirs: excludeDirs,
    dimensions,
    provider,
    indexDir,
    kbAdapter,
    kbAdapterSourceUri,
    knowledgeBases: normalizeKnowledgeBases(file?.knowledgeBases ?? []),
  };
}

/**
 * Save config to file.
 */
export function saveConfig(config: ConfigFile): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  resolvedConfigContext = { configPath, configDir: dir };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

function getConfigContext(): ConfigContext {
  const home = process.env.HOME || "/tmp";
  const configuredPath = envStr("KNOWLEDGE_SEARCH_CONFIG");
  if (configuredPath) {
    const configPath = resolveLocalPath(configuredPath, process.cwd(), home);
    return { configPath, configDir: path.dirname(configPath) };
  }

  const projectPiDir = findProjectPiDir();
  if (projectPiDir) {
    return {
      configPath: path.join(projectPiDir, CONFIG_FILENAME),
      configDir: projectPiDir,
    };
  }

  const configPath = path.join(home, CONFIG_DIR_NAME, CONFIG_FILENAME);
  return { configPath, configDir: path.dirname(configPath) };
}

function envStr(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = envStr(key);
  return v ? parseInt(v, 10) : undefined;
}

function normalizeKnowledgeBases(values: KnowledgeBaseConfigFile[]): KnowledgeBaseConfig[] {
  return values.map((value) => normalizeKnowledgeBase(value));
}

function normalizeKnowledgeBase(value: KnowledgeBaseConfigFile): KnowledgeBaseConfig {
  const id = value.id?.trim();
  if (!id) {
    throw new Error("Knowledge base id is required.");
  }

  const syncMode = value.syncMode ?? "search";
  if (syncMode !== "search" && !value.dataSourceId) {
    throw new Error(
      `Knowledge base ${id} sets syncMode=\"${syncMode}\" but is missing dataSourceId.`
    );
  }

  if (syncMode !== "search" && !value.dataSourceType) {
    throw new Error(
      `Knowledge base ${id} sets syncMode=\"${syncMode}\" but is missing dataSourceType.`
    );
  }

  return {
    id,
    profile: value.profile?.trim() || "default",
    region: value.region?.trim() || "us-east-1",
    ...(value.label?.trim() ? { label: value.label.trim() } : {}),
    ...(value.dataSourceId?.trim() ? { dataSourceId: value.dataSourceId.trim() } : {}),
    ...(value.dataSourceType ? { dataSourceType: value.dataSourceType } : {}),
    syncMode,
    ingestBatchSize: normalizeIngestBatchSize(value.ingestBatchSize),
    pollIntervalMs: normalizePositiveInt(value.pollIntervalMs, 2_000),
    maxWaitMs: normalizePositiveInt(value.maxWaitMs, 300_000),
  };
}

function normalizeIngestBatchSize(value: number | undefined): number {
  const normalized = normalizePositiveInt(value, 25);
  return Math.min(normalized, 25);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

function normalizeKbAdapter(value?: KbAdapterInput): KbAdapter {
  switch (value) {
    case "json_v2":
      return "json_v2";
    case "jsonl_v3":
    case "json_v3":
      return "json_v3";
    case "sqlite_local":
      return "sqlite_local";
    case "jsonl_v4":
    default:
      return "jsonl_v4";
  }
}

function kbAdapterInput(value?: string): KbAdapterInput | undefined {
  switch (value) {
    case "json_v2":
    case "json_v3":
    case "jsonl_v3":
    case "jsonl_v4":
    case "sqlite_local":
      return value;
    default:
      return undefined;
  }
}

function kbAdapterFilename(adapter: KbAdapter): string {
  switch (adapter) {
    case "json_v2":
    case "json_v3":
      return "index.json";
    case "sqlite_local":
      return "index.sqlite";
    case "jsonl_v4":
    default:
      return "index.jsonl";
  }
}

function normalizeKbAdapterSourceUri(
  value: string | undefined,
  adapter: KbAdapter,
  defaultIndexDir: string,
  home: string,
  baseDir: string
): string {
  const fallbackPath = path.join(defaultIndexDir, kbAdapterFilename(adapter));
  const localPath = value ? resolveLocalPath(value, baseDir, home) : fallbackPath;
  return pathToFileURL(localPath).toString();
}

function adapterDirectoryFromSourceUri(uri: string): string {
  if (!uri.startsWith("file:")) {
    throw new Error(`Local adapter source URI must use the file: scheme. Received: ${uri}`);
  }

  return path.dirname(fileURLToPath(uri));
}

function resolveLocalPath(value: string, baseDir: string, home: string): string {
  if (value.startsWith("file:")) {
    return fileURLToPath(value);
  }

  const expanded = expandHomePath(value, home);
  if (path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)) {
    return path.normalize(expanded);
  }

  return path.resolve(baseDir, expanded);
}

function findProjectPiDir(startDir = process.cwd()): string | null {
  let current = path.resolve(startDir);
  let nearestPiSettingsDir: string | null = null;

  while (true) {
    const piDir = path.join(current, CONFIG_DIR_NAME);
    if (fs.existsSync(path.join(piDir, CONFIG_FILENAME))) {
      return piDir;
    }

    if (!nearestPiSettingsDir && fs.existsSync(path.join(piDir, SETTINGS_FILENAME))) {
      nearestPiSettingsDir = piDir;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return nearestPiSettingsDir;
    }
    current = parent;
  }
}

function expandHomePath(value: string, home: string): string {
  if (!value.startsWith("~")) {
    return value;
  }

  return path.join(home, value.slice(1).replace(/^[/\\]+/, ""));
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value);
}
