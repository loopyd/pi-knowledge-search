import { createIndexAdapter } from "./adapters/index.js";
import type {
  Config,
  Embedder,
  IndexAdapter,
  IndexAdapterContext,
  IndexData,
  SearchResult,
  SyncProgress,
  SyncSummary,
} from "./types.js";

export type { SearchResult } from "./types.js";
export { dotProduct } from "./adapters/index.js";

export class KnowledgeIndex {
  private config: Config;
  private embedder: Embedder;
  private data: IndexData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private adapter: IndexAdapter<IndexData, unknown>;

  constructor(config: Config, embedder: Embedder) {
    this.config = config;
    this.embedder = embedder;
    this.adapter = createIndexAdapter(config.kbAdapterSourceUri, config.dimensions, config.kbAdapter);
    this.data = this.adapter.empty();
  }

  reindex(): "running" | "paused";
  reindex(state: "running" | "paused"): void;
  reindex(state?: "running" | "paused"): "running" | "paused" | void {
    if (state == null) {
      return this.adapter.reindex(this.context());
    }

    this.adapter.reindex(state, this.context());
  }

  size(): number {
    // Count unique file paths (not chunks)
    const paths = new Set<string>();
    for (const entry of Object.values(this.data.entries)) {
      paths.add(`${entry.sourceDir}/${entry.relPath}`);
    }
    return paths.size;
  }

  chunkCount(): number {
    return Object.keys(this.data.entries).length;
  }

  /**
   * Load the index from disk.
   */
  async load(): Promise<void> {
    const loaded = await this.adapter.read();
    if (loaded) {
      this.data = loaded;
    }
  }

  private context(): IndexAdapterContext {
    return {
      config: this.config,
      data: this.data,
      embedder: this.embedder,
      scheduleSave: () => this.scheduleSave(),
    };
  }

  private async save(): Promise<void> {
    try {
      await this.adapter.write(this.data);
      this.dirty = false;
    } catch {
      // Best-effort persistence only; keep dirty state for a later retry.
    }
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        void this.save().catch((err) => {
          console.error(`knowledge-search: scheduled save failed: ${(err as Error).message}`);
        });
      }
    }, 5000);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
  }

  /**
   * Scan all configured directories, find new/changed/removed files, update index.
   */
  async sync(onProgress?: (progress: SyncProgress) => void): Promise<SyncSummary> {
    const summary = await this.adapter.sync(this.context(), onProgress);
    if (summary.added + summary.updated + summary.removed > 0) {
      await this.save();
    }
    return summary;
  }

  async reset(onProgress?: (progress: SyncProgress) => void): Promise<void> {
    await this.adapter.reset(this.context(), onProgress);
    await this.close();
  }

  async rebuild(): Promise<void> {
    this.data.entries = {};
    await this.sync();
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    return await this.adapter.search(query, limit, this.context(), signal);
  }

  /**
   * Ingest a single file into the index (called by watcher).
   */
  async ingest(absPath: string, sourceDir: string): Promise<void> {
    await this.adapter.ingest(absPath, sourceDir, this.context());
  }

  remove(absPath: string): void {
    this.adapter.remove(absPath, this.context());
  }

  /** Alias for remove — removes all data for a file path. */
  deleteFile(absPath: string): void {
    this.remove(absPath);
  }

  /** Flush pending saves and release resources. Awaits any in-flight save. */
  async close(): Promise<void> {
    await this.flush();
    await this.adapter.close?.();
  }
}
