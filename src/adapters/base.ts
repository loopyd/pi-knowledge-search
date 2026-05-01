import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterKind, IndexAdapter, IndexData, IndexEntry, KbAdapter, ReindexState } from "../types.js";

export type { IndexAdapter, IndexData, IndexEntry } from "../types.js";

export const JSON_V2_VERSION = 2;
export const JSON_V3_VERSION = 3;
export const INDEX_VERSION = 4;
export const LEGACY_JSON_VERSION = JSON_V3_VERSION;

export interface AdapterSourceDescriptor {
  selectedKind: AdapterKind;
  selectedPath: string;
}

type IndexAdapterCtor = new (source: string, dimensions: number) => IndexAdapter<IndexData, unknown>;

const registry = new Map<KbAdapter, IndexAdapterCtor>();

export function createEmptyIndexData(dimensions: number, version = INDEX_VERSION): IndexData {
  return {
    version,
    dimensions,
    reindexState: "running",
    entries: {},
  };
}

export function registerIndexAdapter(kind: KbAdapter, adapter: IndexAdapterCtor): void {
  registry.set(kind, adapter);
}

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

export abstract class AdapterBase<T, TClient = undefined> implements IndexAdapter<T, TClient> {
  protected client: TClient | undefined;
  private readonly sourceDescriptor: AdapterSourceDescriptor;

  protected constructor(
    source: string | AdapterSourceDescriptor,
    protected readonly dimensions: number,
    private readonly file: string,
    private readonly adapter: AdapterKind,
    private readonly revision: number
  ) {
    this.sourceDescriptor = resolveAdapterSource(source, adapter, file);
  }

  kind(): AdapterKind {
    return this.adapter;
  }

  version(): number {
    return this.revision;
  }

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

  canMigrateFrom<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean {
    return adapter.kind() === this.kind() && adapter.version() === this.version();
  }

  canMigrateTo<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter): boolean {
    return adapter.canMigrateFrom(this as unknown as IndexAdapter<T, unknown>);
  }

  async migrateFrom<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T> {
    if (this.canMigrateFrom(adapter)) {
      return data;
    }

    throw new Error(
      `${this.kind()}@${this.version()} cannot migrate from ${adapter.kind()}@${adapter.version()}`
    );
  }

  async migrateTo<TAdapter extends IndexAdapter<T, unknown>>(adapter: TAdapter, data: T): Promise<T> {
    return await adapter.migrateFrom(this as unknown as IndexAdapter<T, unknown>, data);
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
}

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

function resolveLocalPath(value: string): string {
  return value.startsWith("file:") ? fileURLToPath(value) : value;
}

function looksLikeFilePath(value: string): boolean {
  return path.extname(value) !== "";
}

function siblingPath(selectedPath: string, extension: string): string {
  const parsed = path.parse(selectedPath);
  if (!parsed.ext) {
    return `${selectedPath}${extension}`;
  }

  return path.join(parsed.dir, `${parsed.name}${extension}`);
}

export class ChainAdapter<TData, TClient = undefined> implements IndexAdapter<TData, TClient> {
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

  canMigrateFrom<TAdapter extends IndexAdapter<TData, unknown>>(adapter: TAdapter): boolean {
    return this.target.canMigrateFrom(adapter);
  }

  canMigrateTo<TAdapter extends IndexAdapter<TData, unknown>>(adapter: TAdapter): boolean {
    return this.target.canMigrateTo(adapter);
  }

  async migrateFrom<TAdapter extends IndexAdapter<TData, unknown>>(
    adapter: TAdapter,
    data: TData
  ): Promise<TData> {
    return await this.target.migrateFrom(adapter, data);
  }

  async migrateTo<TAdapter extends IndexAdapter<TData, unknown>>(adapter: TAdapter, data: TData): Promise<TData> {
    return await this.target.migrateTo(adapter, data);
  }

  async read(): Promise<TData | null> {
    await this.target.open?.();
    const current = await this.target.read();
    if (current) {
      return current;
    }

    for (const fallback of this.fallbacks) {
      await fallback.open?.();
      const legacy = await fallback.read();
      if (!legacy) {
        continue;
      }

      let migrated: TData;
      try {
        migrated = await this.migrate(fallback, legacy);
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

  private deletableFallbacks(): IndexAdapter<TData, unknown>[] {
    const targetPath = this.target.path();
    return this.fallbacks.filter((adapter) => adapter.path() !== targetPath);
  }

  private async migrate(source: IndexAdapter<TData, unknown>, data: TData): Promise<TData> {
    const route = this.route(source);
    if (!route) {
      throw new Error(
        `No migration path from ${source.kind()}@${source.version()} to ${this.target.kind()}@${this.target.version()}`
      );
    }

    let migrated = data;
    for (let index = 0; index < route.length - 1; index += 1) {
      migrated = await route[index]!.migrateTo(route[index + 1]!, migrated);
    }
    return migrated;
  }

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
        if (seen.has(candidateKey) || !candidate.canMigrateFrom(current)) {
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