import type * as fs from "node:fs";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export type ReindexState = "running" | "paused";

export type KbAdapter = "json_v2" | "json_v3" | "jsonl_v4" | "sqlite_local";

export type SearchAdapterKind = KbAdapter | "bedrock_v1";

export type KbAdapterInput = KbAdapter | "jsonl_v3";

export type AdapterKind = SearchAdapterKind;

export type SyncPhase = "init" | "scan" | "queue" | "embed" | "upsert" | "done";

export type BedrockKnowledgeBaseDataSourceType = "custom" | "s3";

export type BedrockKnowledgeBaseSyncMode = "search" | "direct" | "ingestion_job";

export type BedrockIngestionJobStatus =
  | "STARTING"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "FAILED"
  | "STOPPING"
  | "STOPPED";

export type BedrockDocumentStatus =
  | "INDEXED"
  | "PARTIALLY_INDEXED"
  | "PENDING"
  | "FAILED"
  | "METADATA_PARTIALLY_INDEXED"
  | "METADATA_UPDATE_FAILED"
  | "IGNORED"
  | "NOT_FOUND"
  | "STARTING"
  | "IN_PROGRESS"
  | "DELETING"
  | "DELETE_IN_PROGRESS";

export interface KnowledgeBaseConfigFile {
  id: string;
  region?: string;
  profile?: string;
  label?: string;
  dataSourceId?: string;
  dataSourceType?: BedrockKnowledgeBaseDataSourceType;
  syncMode?: BedrockKnowledgeBaseSyncMode;
  ingestBatchSize?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface KnowledgeBaseConfig {
  id: string;
  region: string;
  profile: string;
  label?: string;
  dataSourceId?: string;
  dataSourceType?: BedrockKnowledgeBaseDataSourceType;
  syncMode: BedrockKnowledgeBaseSyncMode;
  ingestBatchSize: number;
  pollIntervalMs: number;
  maxWaitMs: number;
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
  knowledgeBases?: KnowledgeBaseConfigFile[];
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

export interface BedrockDocumentFailure {
  identifier: string;
  operation: "ingest" | "delete";
  status: BedrockDocumentStatus;
  reason?: string;
}

export interface BedrockKnowledgeBaseSyncResult {
  knowledgeBaseId: string;
  label?: string;
  mode: BedrockKnowledgeBaseSyncMode;
  status: BedrockDocumentStatus | BedrockIngestionJobStatus;
  documentCount?: number;
  failedDocumentCount?: number;
  documentFailures?: BedrockDocumentFailure[];
  jobId?: string;
  details?: string;
}

export interface SyncSummary {
  added: number;
  updated: number;
  removed: number;
}

export interface ScannedFile {
  absPath: string;
  relPath: string;
  sourceDir: string;
  mtime: number;
}

export interface AdapterSourceDescriptor {
  selectedKind: AdapterKind;
  selectedPath: string;
}

export type BedrockSyncConfig = Pick<Config, "dirs" | "fileExtensions" | "excludeDirs">;

export interface IndexAdapterContext {
  config: Config;
  data: IndexData;
  embedder: Embedder;
  scheduleSave(): void;
}

export interface SearchAdapter<TContext = void> {
  kind(): AdapterKind;
  version(): number;
  search(query: string, limit: number, context: TContext, signal?: AbortSignal): Promise<SearchResult[]>;
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

export interface KnowledgeSearchProgressMessage {
  type: "knowledge-search-progress";
  progress: SyncProgress;
}

export type BedrockClientFactory<TClient = unknown> = (
  profile: string,
  region: string
) => Promise<TClient>;

export type BedrockAgentRuntimeClientFactory<TClient = unknown> = BedrockClientFactory<TClient>;

export type BedrockAgentClientFactory<TClient = unknown> = BedrockClientFactory<TClient>;

export interface BedrockClientEntry {
  client: unknown;
  config: KnowledgeBaseConfig;
}

export interface BedrockLocalDocument {
  absPath: string;
  relPath: string;
  sourceDir: string;
  identifier: string;
}

export type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

export type WatchFactory = (
  path: string,
  options: fs.WatchOptions,
  listener: WatchListener
) => fs.FSWatcher;

export interface IndexAdapter<T, TClient = undefined> extends SearchAdapter<IndexAdapterContext> {
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
  reindex(context: IndexAdapterContext): ReindexState;
  reindex(state: ReindexState, context: IndexAdapterContext): void;
  sync(context: IndexAdapterContext, onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary>;
  reset(context: IndexAdapterContext, onProgress?: (progress: SyncProgress) => void): Promise<void>;
  ingest(absPath: string, sourceDir: string, context: IndexAdapterContext): Promise<void>;
  remove(absPath: string, context: IndexAdapterContext): void;
  accepts<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean;
  migrate<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T>;
}

export type IndexAdapterCtor = new (
  source: string,
  dimensions: number
) => IndexAdapter<IndexData, unknown>;

export interface ControllableIndex {
  load(): Promise<void>;
  flush?(): Promise<void>;
  reset?(onProgress?: (progress: SyncProgress) => void): Promise<void>;
  reindex?(): ReindexState;
  reindex?(state: ReindexState): void;
}

export interface RealtimeWatcher {
  start(): void;
  stop(): void;
}

export interface StartOptions {
  config: Config;
  index: ControllableIndex | null;
  ctx: any;
  realtime?: RealtimeWatcher | null;
}