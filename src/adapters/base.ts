/* Shared adapter primitives for all on-disk index backends. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkMarkdown } from "../chunker.js";
import type {
  AdapterSourceDescriptor,
  AdapterKind,
  Chunk,
  IndexAdapter,
  IndexAdapterContext,
  IndexAdapterCtor,
  IndexData,
  IndexEntry,
  KbAdapter,
  ReindexState,
  ScannedFile,
  SearchAdapter,
  SearchResult,
  SyncProgress,
  SyncSummary,
} from "../types.js";

export type {
  AdapterSourceDescriptor,
  IndexAdapter,
  IndexData,
  IndexEntry,
  SearchAdapter,
} from "../types.js";

/* Version markers for the formats this adapter layer knows how to read and migrate. */
export const JSON_V2_VERSION = 2;
export const JSON_V3_VERSION = 3;
export const INDEX_VERSION = 4;
export const LEGACY_JSON_VERSION = JSON_V3_VERSION;

/* Shared streaming chunk size for legacy whole-object JSON readers. */
export const JSON_STREAM_CHUNK_BYTES = 256 * 1024;
const SEARCH_SCORE_THRESHOLD = 0.15;
const MAX_EXCERPT_LENGTH = 3500;
const EMBED_BATCH_SIZE = 50;

const registry = new Map<KbAdapter, IndexAdapterCtor>();

/* Create a blank in-memory index payload for a target revision. */
export function createEmptyIndexData(dimensions: number, version = INDEX_VERSION): IndexData {
  return {
    version,
    dimensions,
    reindexState: "running",
    entries: {},
  };
}

/* Register a concrete adapter class so callers can request it by configured kind. */
export function registerIndexAdapter(kind: KbAdapter, adapter: IndexAdapterCtor): void {
  registry.set(kind, adapter);
}

/* Resolve a configured adapter kind into its concrete implementation. */
export function createIndexAdapter(
  source: string,
  dimensions: number,
  adapter: KbAdapter
): IndexAdapter<IndexData, unknown> {
  const Adapter = registry.get(adapter);
  if (!Adapter) {
    throw new Error(`Unknown index adapter: ${adapter}`);
  }
  return new Adapter(source, dimensions);
}

/* Dot product — works as cosine similarity when vectors are pre-normalized. */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Shared contract for anything that can answer knowledge-search queries.
 *
 * Local index adapters and remote knowledge sources both hang off this base so
 * the extension can merge search results without caring how the backing data is
 * stored or retrieved.
 */
export abstract class SearchAdapterBase<TContext = void> implements SearchAdapter<TContext> {
  abstract kind(): AdapterKind;
  abstract version(): number;
  abstract search(
    query: string,
    limit: number,
    context: TContext,
    signal?: AbortSignal
  ): Promise<SearchResult[]>;
}

/**
 * Base implementation shared by all persistence adapters.
 *
 * The main runtime only talks to the standardized IndexAdapter interface. This
 * base class keeps path resolution, atomic writes, validation helpers, and
 * migration defaults in one place so format-specific adapters only implement
 * their own storage details.
 */
export abstract class AdapterBase<T, TClient = undefined>
  extends SearchAdapterBase<IndexAdapterContext>
  implements IndexAdapter<T, TClient>
{
  protected client: TClient | undefined;
  private readonly sourceDescriptor: AdapterSourceDescriptor;

  /**
   * Build a format-specific adapter around a configured source path.
   *
   * `source` may be the original configured path/URI or a descriptor inherited
   * from another adapter in a migration chain. The descriptor form is what lets
   * fallback adapters stay wired to the same logical index while swapping file
   * extensions under the hood.
   */
  protected constructor(
    source: string | AdapterSourceDescriptor,
    protected readonly dimensions: number,
    private readonly file: string,
    private readonly adapter: AdapterKind,
    private readonly revision: number
  ) {
    super();
    this.sourceDescriptor = resolveAdapterSource(source, adapter, file);
  }

  kind(): AdapterKind {
    return this.adapter;
  }

  version(): number {
    return this.revision;
  }

  /* Preserve the selected path for the active format and derive sibling paths for fallbacks. */
  path(): string {
    if (this.sourceDescriptor.selectedKind === this.adapter) {
      return this.sourceDescriptor.selectedPath;
    }

    return siblingPath(this.sourceDescriptor.selectedPath, path.extname(this.file));
  }

  exists(): boolean {
    return fs.existsSync(this.path());
  }

  empty(): T {
    return this.blank();
  }

  async open(): Promise<TClient | undefined> {
    return this.client;
  }

  async close(): Promise<void> {
    // Default no-op.
  }

  accepts<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean {
    return adapter.kind() === this.kind() && adapter.version() === this.version();
  }

  async migrate<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T> {
    if (this.accepts(adapter)) {
      return data;
    }

    throw new Error(
      `${this.kind()}@${this.version()} cannot migrate from ${adapter.kind()}@${adapter.version()}`
    );
  }

  abstract read(): Promise<T | null>;
  abstract write(data: T): Promise<void>;

  async create(data: T): Promise<void> {
    await this.write(data);
  }

  async update(data: T): Promise<void> {
    await this.write(data);
  }

  async delete(): Promise<void> {
    try {
      await fs.promises.rm(this.path(), { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  reindex(context: IndexAdapterContext): ReindexState;
  reindex(state: ReindexState, context: IndexAdapterContext): void;
  reindex(
    stateOrContext: ReindexState | IndexAdapterContext,
    context?: IndexAdapterContext
  ): ReindexState | void {
    if (!context) {
      return this.state((stateOrContext as IndexAdapterContext).data.reindexState);
    }

    const nextState = stateOrContext as ReindexState;
    if (context.data.reindexState === nextState) return;
    context.data.reindexState = nextState;
    context.scheduleSave();
  }

  async search(
    query: string,
    limit: number,
    context: IndexAdapterContext,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    const queryVector = await context.embedder.embed(query, signal);
    const scored: { key: string; absPath: string; score: number }[] = [];

    for (const [key, entry] of Object.entries(context.data.entries)) {
      const score = dotProduct(queryVector, entry.vector);
      scored.push({ key, absPath: this.absPathFromKey(key), score });
    }

    scored.sort((left, right) => right.score - left.score);

    const seenPaths = new Set<string>();
    const deduped: { key: string; absPath: string; score: number }[] = [];
    for (const item of scored) {
      if (item.score <= SEARCH_SCORE_THRESHOLD || seenPaths.has(item.absPath)) {
        continue;
      }

      seenPaths.add(item.absPath);
      deduped.push(item);
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped.map((item) => {
      const entry = context.data.entries[item.key]!;
      return {
        path: item.absPath,
        score: item.score,
        excerpt: entry.excerpt,
        heading: entry.heading,
      } satisfies SearchResult;
    });
  }

  async sync(
    context: IndexAdapterContext,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<SyncSummary> {
    const allFiles = this.scanAllFiles(context);
    const currentPaths = new Set(allFiles.map((file) => file.absPath));

    let removed = 0;
    const seenRemoved = new Set<string>();
    for (const key of Object.keys(context.data.entries)) {
      const absPath = this.absPathFromKey(key);
      if (!currentPaths.has(absPath) && !seenRemoved.has(absPath)) {
        seenRemoved.add(absPath);
        removed += 1;
        this.removeAllChunks(absPath, context.data);
      }
    }

    this.emitProgress(onProgress, {
      phase: "scan",
      processed: allFiles.length,
      total: allFiles.length,
      added: 0,
      updated: 0,
      removed,
    });

    const toProcess: Array<{ file: ScannedFile; chunks: Chunk[] }> = [];
    for (const file of allFiles) {
      const existing = context.data.entries[this.entryKey(file.absPath, 0)];
      if (existing && existing.mtime >= file.mtime) {
        continue;
      }

      const content = this.readFileContent(file.absPath);
      if (!content || content.trim().length <= 20) {
        continue;
      }

      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) {
        continue;
      }

      toProcess.push({ file, chunks });
    }

    this.emitProgress(onProgress, {
      phase: "queue",
      processed: toProcess.length,
      total: toProcess.length,
      added: 0,
      updated: 0,
      removed,
    });

    let added = 0;
    let updated = 0;

    if (toProcess.length > 0) {
      const allChunkTexts: string[] = [];
      const chunkMeta: Array<{ fileIdx: number; chunkIdx: number }> = [];

      for (let fileIdx = 0; fileIdx < toProcess.length; fileIdx += 1) {
        const current = toProcess[fileIdx]!;
        for (let chunkIdx = 0; chunkIdx < current.chunks.length; chunkIdx += 1) {
          const chunk = current.chunks[chunkIdx]!;
          allChunkTexts.push(this.chunkEmbedText(current.file.relPath, chunk.heading, chunk.text));
          chunkMeta.push({ fileIdx, chunkIdx });
        }
      }

      const allVectors: Array<number[] | null> = new Array(allChunkTexts.length).fill(null);
      for (let index = 0; index < allChunkTexts.length; index += EMBED_BATCH_SIZE) {
        const batchTexts = allChunkTexts.slice(index, index + EMBED_BATCH_SIZE);
        const vectors = await context.embedder.embedBatch(batchTexts);
        for (let offset = 0; offset < vectors.length; offset += 1) {
          allVectors[index + offset] = vectors[offset] ?? null;
        }

        this.emitProgress(onProgress, {
          phase: "embed",
          processed: Math.min(index + vectors.length, allChunkTexts.length),
          total: allChunkTexts.length,
          added,
          updated,
          removed,
        });
      }

      const processedFiles = new Set<number>();
      for (let index = 0; index < chunkMeta.length; index += 1) {
        const { fileIdx, chunkIdx } = chunkMeta[index]!;
        const vector = allVectors[index];
        if (!vector) {
          continue;
        }

        const current = toProcess[fileIdx]!;
        if (!processedFiles.has(fileIdx)) {
          processedFiles.add(fileIdx);
          const hadExisting = this.removeAllChunks(current.file.absPath, context.data) > 0;
          if (hadExisting) updated += 1;
          else added += 1;
        }

        const chunk = current.chunks[chunkIdx]!;
        context.data.entries[this.entryKey(current.file.absPath, chunkIdx)] = {
          relPath: current.file.relPath,
          sourceDir: current.file.sourceDir,
          mtime: current.file.mtime,
          vector,
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: chunkIdx,
        };

        this.emitProgress(onProgress, {
          phase: "upsert",
          processed: index + 1,
          total: chunkMeta.length,
          added,
          updated,
          removed,
        });
      }
    }

    return { added, updated, removed };
  }

  async reset(
    context: IndexAdapterContext,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<void> {
    this.emitProgress(onProgress, {
      phase: "init",
      processed: 0,
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      detail: "resetting index state",
    });
    context.data.entries = {};
    context.scheduleSave();
  }

  async ingest(absPath: string, sourceDir: string, context: IndexAdapterContext): Promise<void> {
    if (!fs.existsSync(absPath)) {
      this.remove(absPath, context);
      return;
    }

    const relPath = path.relative(sourceDir, absPath);
    if (this.shouldSkip(relPath, context.config)) {
      return;
    }

    const stat = fs.statSync(absPath);
    const content = this.readFileContent(absPath);
    if (!content || content.trim().length <= 20) {
      this.remove(absPath, context);
      return;
    }

    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.remove(absPath, context);
      return;
    }

    this.removeAllChunks(absPath, context.data);

    const texts = chunks.map((chunk) => this.chunkEmbedText(relPath, chunk.heading, chunk.text));
    const vectors = await context.embedder.embedBatch(texts);

    for (let index = 0; index < chunks.length; index += 1) {
      const vector = vectors[index];
      if (!vector) {
        continue;
      }

      const chunk = chunks[index]!;
      context.data.entries[this.entryKey(absPath, index)] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
        heading: chunk.heading,
        chunkIndex: index,
      };
    }

    context.scheduleSave();
  }

  remove(absPath: string, context: IndexAdapterContext): void {
    if (this.removeAllChunks(absPath, context.data) > 0) {
      context.scheduleSave();
    }
  }

  protected state(value?: string): ReindexState {
    return value === "paused" ? "paused" : "running";
  }

  protected data(entries: Record<string, IndexEntry>, state?: string, version = this.version()): IndexData {
    return {
      version,
      dimensions: this.dimensions,
      reindexState: this.state(state),
      entries,
    };
  }

  protected blank(): T {
    return createEmptyIndexData(this.dimensions, this.version()) as T;
  }

  protected migrated(data: IndexData, version = this.version()): IndexData {
    return {
      ...data,
      version,
      dimensions: this.dimensions,
      reindexState: this.state(data.reindexState),
      entries: { ...data.entries },
    };
  }

  protected bind(client: TClient): TClient {
    this.client = client;
    return client;
  }

  protected ensure(): void {
    fs.mkdirSync(path.dirname(this.path()), { recursive: true });
  }

  protected async atomic(run: (tmp: string) => Promise<void>): Promise<void> {
    this.ensure();
    const final = this.path();
    const tmp = `${final}.tmp`;

    try {
      await run(tmp);
      await fs.promises.rename(tmp, final);
    } catch (error) {
      try {
        await fs.promises.rm(tmp, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
      throw error;
    }
  }

  /* Validate that a hydrated entry conforms to the normalized v3/v4 shape. */
  protected valid(value: unknown): value is IndexEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<IndexEntry>;
    return (
      typeof entry.relPath === "string" &&
      typeof entry.sourceDir === "string" &&
      typeof entry.mtime === "number" &&
      Array.isArray(entry.vector) &&
      typeof entry.excerpt === "string" &&
      typeof entry.heading === "string" &&
      typeof entry.chunkIndex === "number"
    );
  }

  protected emitProgress(
    onProgress: ((progress: SyncProgress) => void) | undefined,
    progress: SyncProgress
  ): void {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch {
      // Ignore progress callback failures.
    }
  }

  protected entryKey(absPath: string, chunkIndex: number): string {
    return `${absPath}#${chunkIndex}`;
  }

  protected absPathFromKey(key: string): string {
    const hashIdx = key.lastIndexOf("#");
    return hashIdx >= 0 ? key.slice(0, hashIdx) : key;
  }

  protected removeAllChunks(absPath: string, data: IndexData): number {
    const prefix = `${absPath}#`;
    const toRemove = Object.keys(data.entries).filter((key) => key.startsWith(prefix));
    for (const key of toRemove) {
      delete data.entries[key];
    }
    return toRemove.length;
  }

  protected chunkEmbedText(relPath: string, heading: string, chunkText: string): string {
    const title = relPath.replace(/\.[^.]+$/, "").replace(/\//g, " > ");
    const sectionContext = heading && heading !== "intro" ? ` > ${heading}` : "";
    return `Title: ${title}${sectionContext}\n\n${chunkText}`;
  }

  protected scanAllFiles(context: IndexAdapterContext): ScannedFile[] {
    const results: ScannedFile[] = [];
    for (const dir of context.config.dirs) {
      this.walkDir(dir, dir, results, context.config);
    }
    return results;
  }

  protected walkDir(
    currentDir: string,
    sourceDir: string,
    results: ScannedFile[],
    config: IndexAdapterContext["config"]
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (config.excludeDirs.includes(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        this.walkDir(absPath, sourceDir, results, config);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!config.fileExtensions.includes(path.extname(entry.name))) {
        continue;
      }

      const relPath = path.relative(sourceDir, absPath);
      if (this.shouldSkip(relPath, config)) {
        continue;
      }

      try {
        const stat = fs.statSync(absPath);
        results.push({ absPath, relPath, sourceDir, mtime: stat.mtimeMs });
      } catch {
        // Skip unreadable files.
      }
    }
  }

  protected shouldSkip(relPath: string, config: IndexAdapterContext["config"]): boolean {
    const parts = relPath.split(path.sep);
    for (const part of parts) {
      if (config.excludeDirs.includes(part) || part.startsWith(".")) {
        return true;
      }
    }
    return false;
  }

  protected readFileContent(absPath: string): string | null {
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    } catch {
      return null;
    }
  }
}

/* Normalize a configured source into a descriptor the adapter layer can reason about. */
function resolveAdapterSource(
  input: string | AdapterSourceDescriptor,
  adapter: AdapterKind,
  file: string
): AdapterSourceDescriptor {
  if (typeof input !== "string") {
    return input;
  }

  const localPath = resolveLocalPath(input);
  if (looksLikeFilePath(localPath)) {
    return {
      selectedKind: adapter,
      selectedPath: path.resolve(localPath),
    };
  }

  return {
    selectedKind: adapter,
    selectedPath: path.join(path.resolve(localPath), file),
  };
}

/* Convert a file URI into a local path while preserving plain filesystem inputs. */
function resolveLocalPath(value: string): string {
  return value.startsWith("file:") ? fileURLToPath(value) : value;
}

/* Treat any configured source with an extension as an explicit file path. */
function looksLikeFilePath(value: string): boolean {
  return path.extname(value) !== "";
}

/* Swap the extension on the selected path so fallback adapters point at sibling files. */
function siblingPath(selectedPath: string, extension: string): string {
  const parsed = path.parse(selectedPath);
  if (!parsed.ext) {
    return `${selectedPath}${extension}`;
  }

  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

/**
 * Adapter wrapper that presents a single clean interface while hiding migration chains.
 *
 * KnowledgeIndex only needs one adapter instance. ChainAdapter tries the requested
 * target format first, then walks older formats, migrates data forward through the
 * adapter graph, and finally rewrites the target so the rest of the application can
 * stay format-agnostic.
 */
export class ChainAdapter<TData, TClient = undefined> implements IndexAdapter<TData, TClient> {
  /**
   * Compose the canonical target adapter with any readable fallback adapters.
   *
   * The target defines the public surface presented to callers; fallbacks only
   * exist to read legacy files and migrate them forward.
   */
  constructor(
    private readonly target: IndexAdapter<TData, TClient>,
    private readonly fallbacks: IndexAdapter<TData, unknown>[] = []
  ) {}

  kind(): AdapterKind {
    return this.target.kind();
  }

  version(): number {
    return this.target.version();
  }

  path(): string {
    return this.target.path();
  }

  exists(): boolean {
    return this.target.exists() || this.fallbacks.some((adapter) => adapter.exists());
  }

  empty(): TData {
    return this.target.empty();
  }

  async open(): Promise<TClient | undefined> {
    return await this.target.open?.();
  }

  async close(): Promise<void> {
    await this.target.close?.();
    await Promise.allSettled(this.fallbacks.map(async (adapter) => await adapter.close?.()));
  }

  reindex(context: IndexAdapterContext): ReindexState;
  reindex(state: ReindexState, context: IndexAdapterContext): void;
  reindex(
    stateOrContext: ReindexState | IndexAdapterContext,
    context?: IndexAdapterContext
  ): ReindexState | void {
    if (!context) {
      return this.target.reindex(stateOrContext as IndexAdapterContext);
    }

    return this.target.reindex(stateOrContext as ReindexState, context);
  }

  async search(
    query: string,
    limit: number,
    context: IndexAdapterContext,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    return await this.target.search(query, limit, context, signal);
  }

  async sync(
    context: IndexAdapterContext,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<SyncSummary> {
    return await this.target.sync(context, onProgress);
  }

  async reset(
    context: IndexAdapterContext,
    onProgress?: (progress: SyncProgress) => void
  ): Promise<void> {
    await this.target.reset(context, onProgress);
  }

  async ingest(absPath: string, sourceDir: string, context: IndexAdapterContext): Promise<void> {
    await this.target.ingest(absPath, sourceDir, context);
  }

  remove(absPath: string, context: IndexAdapterContext): void {
    this.target.remove(absPath, context);
  }

  accepts<TAdapter extends IndexAdapter<TData, unknown>>(adapter: TAdapter): boolean {
    return this.target.accepts(adapter);
  }

  async migrate<TAdapter extends IndexAdapter<TData, unknown>>(
    adapter: TAdapter,
    data: TData
  ): Promise<TData> {
    return await this.target.migrate(adapter, data);
  }

  async read(): Promise<TData | null> {
    await this.target.open?.();
    const current = await this.target.read();
    if (current) {
      return current;
    }

    /* Fall back to legacy formats, migrate forward, then persist only the target format. */
    for (const fallback of this.fallbacks) {
      await fallback.open?.();
      const legacy = await fallback.read();
      if (!legacy) {
        continue;
      }

      let migrated: TData;
      try {
        migrated = await this.convert(fallback, legacy);
      } catch {
        continue;
      }

      await this.target.create(migrated);
      await Promise.allSettled(
        this.deletableFallbacks().map(async (adapter) => await adapter.delete())
      );
      return (await this.target.read()) ?? migrated;
    }

    return null;
  }

  async write(data: TData): Promise<void> {
    await this.target.open?.();
    await this.target.write(data);
  }

  async create(data: TData): Promise<void> {
    await this.target.open?.();
    await this.target.create(data);
  }

  async update(data: TData): Promise<void> {
    await this.target.open?.();
    await this.target.update(data);
  }

  async delete(): Promise<void> {
    await Promise.all([
      this.target.delete(),
      ...this.deletableFallbacks().map(async (adapter) => await adapter.delete()),
    ]);
  }

  /* Keep same-path fallbacks alive so in-place migrations do not delete the new target. */
  private deletableFallbacks(): IndexAdapter<TData, unknown>[] {
    const targetPath = this.target.path();
    return this.fallbacks.filter((adapter) => adapter.path() !== targetPath);
  }

  private async convert(source: IndexAdapter<TData, unknown>, data: TData): Promise<TData> {
    const route = this.route(source);
    if (!route) {
      throw new Error(
        `No migration path from ${source.kind()}@${source.version()} to ${this.target.kind()}@${this.target.version()}`
      );
    }

    let migrated = data;
    for (let index = 0; index < route.length - 1; index += 1) {
      migrated = await route[index + 1]!.migrate(route[index]!, migrated);
    }
    return migrated;
  }

  /* Breadth-first search across the adapter graph keeps the migration route explicit and minimal. */
  private route(source: IndexAdapter<TData, unknown>): IndexAdapter<TData, unknown>[] | null {
    const targetKey = this.key(this.target);
    const queue: IndexAdapter<TData, unknown>[][] = [[source]];
    const seen = new Set<string>([this.key(source)]);

    while (queue.length > 0) {
      const currentRoute = queue.shift();
      if (!currentRoute) {
        continue;
      }

      const current = currentRoute[currentRoute.length - 1]!;
      if (this.key(current) === targetKey) {
        return currentRoute;
      }

      for (const candidate of this.adapters(source)) {
        const candidateKey = this.key(candidate);
        if (seen.has(candidateKey) || !candidate.accepts(current)) {
          continue;
        }

        seen.add(candidateKey);
        queue.push([...currentRoute, candidate]);
      }
    }

    return null;
  }

  private adapters(source: IndexAdapter<TData, unknown>): IndexAdapter<TData, unknown>[] {
    return Array.from(
      new Map(
        [source, this.target, ...this.fallbacks].map((adapter) => [this.key(adapter), adapter])
      ).values()
    );
  }

  private key(adapter: IndexAdapter<TData, unknown>): string {
    return `${adapter.kind()}@${adapter.version()}`;
  }
}