/* SQLite-backed adapter implemented through Drizzle and a hand-authored migration. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { AdapterBase, INDEX_VERSION } from "./base.js";
import type { AdapterSourceDescriptor, IndexAdapter, IndexData, SqliteStore } from "../types.js";

/* Key/value metadata table describing the current logical index state. */
const metaTable = sqliteTable("kb_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/* Entry table holding one normalized chunk record per indexed chunk. */
const entryTable = sqliteTable("kb_entries", {
  key: text("key").primaryKey(),
  absPath: text("abs_path").notNull(),
  relPath: text("rel_path").notNull(),
  sourceDir: text("source_dir").notNull(),
  mtime: integer("mtime", { mode: "number" }).notNull(),
  vector: text("vector").notNull(),
  excerpt: text("excerpt").notNull(),
  heading: text("heading").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
});

/* Drizzle schema bundle passed to the driver and the migrator. */
const schema = {
  metaTable,
  entryTable,
} satisfies Record<string, unknown>;

type SqliteSchema = typeof schema;

const META_VERSION = "version";
const META_DIMENSIONS = "dimensions";
const META_REINDEX = "reindexState";
const INSERT_BATCH = 200;
const MIGRATIONS_TABLE = "kb_drizzle_migrations";

function resolveMigrationsFolder(metaUrl: string): string {
  const candidates = [
    fileURLToPath(new URL("../../drizzle", metaUrl)),
    fileURLToPath(new URL("../drizzle", metaUrl)),
  ];

  const resolved = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "meta", "_journal.json"))
  );

  return resolved ?? candidates[0];
}

const MIGRATIONS_FOLDER = resolveMigrationsFolder(import.meta.url);

/**
 * SQLite adapter for the current v4 logical index model.
 *
 * This adapter exposes the same IndexAdapter interface as the JSON formats, but
 * persists rows through Drizzle so the rest of the runtime can switch storage
 * backends without caring about SQL details.
 */
export class SqliteV4Adapter extends AdapterBase<IndexData, SqliteStore<SqliteSchema>> {
  /**
   * Wrap a SQLite source path or a descriptor inherited from a migration chain.
   *
   * Descriptors let legacy fallbacks and the SQLite target stay anchored to the
   * same logical configured source while still choosing their own file names.
   */
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.sqlite", "sqlite_local", INDEX_VERSION);
  }

  /**
   * Open the SQLite database and ensure its schema is available.
   *
   * This doubles as the adapter's constructor-time resource initializer. The
   * Drizzle migrator keeps schema bootstrap hand-authored while still routing all
   * runtime data access through the ORM surface.
   */
  override async open(): Promise<SqliteStore<SqliteSchema>> {
    if (this.client) {
      return this.client;
    }

    this.ensure();
    const client = new Database(this.path());
    const orm = drizzle(client, { schema });
    client.pragma("journal_mode = WAL");
    migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER, migrationsTable: MIGRATIONS_TABLE });

    return this.bind({ client, orm });
  }

  /**
   * Close the active SQLite handle.
   *
   * This is the adapter's destructor-equivalent cleanup hook and is safe to call
   * repeatedly because the cached client is cleared after closing.
   */
  override async close(): Promise<void> {
    this.client?.client.close();
    this.client = undefined;
  }

  /* Read metadata first, then hydrate entries row-by-row into the normalized index shape. */
  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    try {
      const store = await this.open();
      const metaRows = store.orm.select().from(metaTable).all();
      const meta = new Map(metaRows.map((row) => [row.key, row.value]));
      const version = Number.parseInt(meta.get(META_VERSION) ?? "", 10);
      const dimensions = Number.parseInt(meta.get(META_DIMENSIONS) ?? "", 10);

      if (version !== INDEX_VERSION || dimensions !== this.dimensions) {
        return null;
      }

      const data = this.data({}, meta.get(META_REINDEX) ?? undefined, INDEX_VERSION);
      const rows = store.orm.select().from(entryTable).all();
      for (const row of rows) {
        try {
          const vector = JSON.parse(row.vector) as number[];
          if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
            continue;
          }
          data.entries[row.key] = {
            relPath: row.relPath,
            sourceDir: row.sourceDir,
            mtime: row.mtime,
            vector,
            excerpt: row.excerpt,
            heading: row.heading,
            chunkIndex: row.chunkIndex,
          };
        } catch {
          // Skip corrupt rows.
        }
      }
      return data;
    } catch {
      return null;
    }
  }

  /* Rewrite the SQLite index inside one Drizzle transaction so callers see one coherent snapshot. */
  async write(data: IndexData): Promise<void> {
    const store = await this.open();
    const entries = Object.entries(data.entries);
    store.orm.transaction((tx) => {
      tx.delete(metaTable).run();
      tx.delete(entryTable).run();

      tx.insert(metaTable)
        .values([
          { key: META_VERSION, value: String(INDEX_VERSION) },
          { key: META_DIMENSIONS, value: String(this.dimensions) },
          { key: META_REINDEX, value: data.reindexState },
        ])
        .run();

      for (let index = 0; index < entries.length; index += INSERT_BATCH) {
        const batch = entries.slice(index, index + INSERT_BATCH).map(([key, entry]) => ({
          key,
          absPath: this.abs(key),
          relPath: entry.relPath,
          sourceDir: entry.sourceDir,
          mtime: entry.mtime,
          vector: JSON.stringify(entry.vector),
          excerpt: entry.excerpt,
          heading: entry.heading,
          chunkIndex: entry.chunkIndex,
        }));
        if (batch.length > 0) {
          tx.insert(entryTable).values(batch).run();
        }
      }
    });
  }

  override accepts<TAdapter extends IndexAdapter<IndexData, unknown>>(adapter: TAdapter): boolean {
    return (
      super.accepts(adapter) ||
      (adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION)
    );
  }

  override async migrate<TAdapter extends IndexAdapter<IndexData, unknown>>(
    adapter: TAdapter,
    data: IndexData
  ): Promise<IndexData> {
    if (adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION) {
      return this.migrated(data, INDEX_VERSION);
    }

    return await super.migrate(adapter, data);
  }

  /**
   * Delete the SQLite database after releasing any open handle.
   *
   * This is the destructive cleanup path used by migration chains and explicit
   * adapter deletion requests.
   */
  override async delete(): Promise<void> {
    await this.close();
    if (!this.exists()) {
      return;
    }
    await fs.promises.rm(this.path(), { force: true });
  }

  /* Strip the chunk suffix from an entry key so SQLite can store the owning file path explicitly. */
  private abs(key: string): string {
    const hash = key.lastIndexOf("#");
    return hash >= 0 ? key.slice(0, hash) : key;
  }
}