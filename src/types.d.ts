import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type ReindexState = "running" | "paused";

export type KbAdapter = "json_v2" | "json_v3" | "jsonl_v4" | "sqlite_local";

export type KbAdapterInput = KbAdapter | "jsonl_v3";

export type AdapterKind = KbAdapter;

export type SyncPhase = "init" | "scan" | "queue" | "embed" | "upsert" | "done";

export interface KnowledgeBaseConfig {
  id: string;
  region?: string;
  profile?: string;
  label?: string;
}

export interface OpenAIProviderConfig {
  type: "openai";
  apiKey: string;
  model: string;
}

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  apiKey?: string;
  model: string;
  baseUrl: string;
}

export interface BedrockProviderConfig {
  type: "bedrock";
  profile: string;
  region: string;
  model: string;
}

export interface OllamaProviderConfig {
  type: "ollama";
  url: string;
  model: string;
}

export type ProviderConfig =
  | OpenAIProviderConfig
  | OpenAICompatibleProviderConfig
  | BedrockProviderConfig
  | OllamaProviderConfig;

export interface OpenAIProviderConfigFile {
  type: "openai";
  apiKey?: string;
  model?: string;
}

export interface OpenAICompatibleProviderConfigFile {
  type: "openai-compatible";
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface BedrockProviderConfigFile {
  type: "bedrock";
  profile?: string;
  region?: string;
  model?: string;
}

export interface OllamaProviderConfigFile {
  type: "ollama";
  url?: string;
  model?: string;
}

export type ProviderConfigFile =
  | OpenAIProviderConfigFile
  | OpenAICompatibleProviderConfigFile
  | BedrockProviderConfigFile
  | OllamaProviderConfigFile;

export interface Config {
  dirs: string[];
  fileExtensions: string[];
  excludeDirs: string[];
  dimensions: number;
  provider: ProviderConfig | null;
  indexDir: string;
  kbAdapter: KbAdapter;
  kbAdapterSourceUri: string;
  knowledgeBases: KnowledgeBaseConfig[];
}

export interface ConfigFile {
  dirs?: string[];
  fileExtensions?: string[];
  excludeDirs?: string[];
  dimensions?: number;
  kbAdapter?: KbAdapterInput;
  kbAdapterSourceUri?: string;
  knowledgeBases?: KnowledgeBaseConfig[];
  provider?: ProviderConfigFile;
}

export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency?: number
  ): Promise<(number[] | null)[]>;
}

export interface Chunk {
  text: string;
  heading: string;
  startLine: number;
  charOffset: number;
}

export interface Section {
  text: string;
  heading: string;
  startLine: number;
  charOffset: number;
}

export interface OffsetRange {
  start: number;
  end: number;
}

export interface IndexEntry {
  relPath: string;
  sourceDir: string;
  mtime: number;
  vector: number[];
  excerpt: string;
  heading: string;
  chunkIndex: number;
}

export interface IndexData {
  version: number;
  dimensions: number;
  reindexState: ReindexState;
  entries: Record<string, IndexEntry>;
}

export interface IndexAdapter<T, TClient = undefined> {
  kind(): AdapterKind;
  version(): number;
  path(): string;
  exists(): boolean;
  empty(): T;
  open?(): Promise<TClient | undefined>;
  close?(): Promise<void>;
  read(): Promise<T | null>;
  write(data: T): Promise<void>;
  create(data: T): Promise<void>;
  update(data: T): Promise<void>;
  delete(): Promise<void>;
  canMigrateFrom<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean;
  canMigrateTo<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean;
  migrateFrom<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T>;
  migrateTo<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T>;
}

export interface LegacyIndexEntry {
  relPath: string;
  sourceDir: string;
  mtime: number;
  vector: number[];
  excerpt: string;
}

export interface JsonV2Data {
  version: 2;
  dimensions: number;
  entries?: Record<string, LegacyIndexEntry>;
}

export type SqliteClient = Database.Database;

export type SqliteOrm<TSchema extends Record<string, unknown> = Record<string, never>> =
  BetterSQLite3Database<TSchema> & {
    $client: SqliteClient;
  };

export interface SqliteStore<TSchema extends Record<string, unknown> = Record<string, never>> {
  client: SqliteClient;
  orm: SqliteOrm<TSchema>;
}

export interface JsonV3Data {
  version: number;
  dimensions: number;
  entries?: Record<string, IndexEntry>;
}

export type JsonlLine =
  | {
      type: "meta";
      version: number;
      dimensions: number;
      reindexState?: ReindexState;
    }
  | {
      type: "entry";
      key: string;
      entry: IndexData["entries"][string];
    };

export interface SearchResult {
  path: string;
  score: number;
  excerpt: string;
  heading: string;
}

export interface SyncProgress {
  phase: SyncPhase;
  processed: number;
  total: number;
  added: number;
  updated: number;
  removed: number;
  detail?: string;
}

export interface SyncWorkerResult {
  added: number;
  updated: number;
  removed: number;
  size: number;
  chunks: number;
}

export interface ControllableIndex {
  load(): Promise<void>;
  reset?(onProgress?: (progress: SyncProgress) => void): Promise<void>;
  reindexState?(): ReindexState;
  setReindexState?(state: ReindexState): void;
}

export interface StartOptions {
  config: Config;
  index: ControllableIndex | null;
  ctx: any;
}