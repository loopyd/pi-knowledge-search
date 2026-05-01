import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { AdapterBase, INDEX_VERSION } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import type { IndexAdapter, IndexData, SqliteStore } from "../types.js";

const metaTable = sqliteTable("kb_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

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

const schema = {
  metaTable,
  entryTable,
} satisfies Record<string, unknown>;

type SqliteSchema = typeof schema;

const META_VERSION = "version";
const META_DIMENSIONS = "dimensions";
const META_REINDEX = "reindexState";
const INSERT_BATCH = 200;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const MIGRATIONS_TABLE = "kb_drizzle_migrations";

export class SqliteV4Adapter extends AdapterBase<IndexData, SqliteStore<SqliteSchema>> {
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.sqlite", "sqlite_local", INDEX_VERSION);
  }

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

  override async close(): Promise<void> {
    this.client?.client.close();
    this.client = undefined;
  }

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

  override canMigrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(adapter: TAdapter): boolean {
    return (
      super.canMigrateFrom(adapter) ||
      (adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION)
    );
  }

  override async migrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(
    adapter: TAdapter,
    data: IndexData
  ): Promise<IndexData> {
    if (adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION) {
      return this.migrated(data, INDEX_VERSION);
    }

    return await super.migrateFrom(adapter, data);
  }

  override async delete(): Promise<void> {
    await this.close();
    if (!this.exists()) {
      return;
    }
    await fs.promises.rm(this.path(), { force: true });
  }

  private abs(key: string): string {
    const hash = key.lastIndexOf("#");
    return hash >= 0 ? key.slice(0, hash) : key;
  }
}