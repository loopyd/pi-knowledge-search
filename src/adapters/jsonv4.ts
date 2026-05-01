import * as fs from "node:fs";
import * as readline from "node:readline";
import { AdapterBase, INDEX_VERSION, LEGACY_JSON_VERSION } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import type { IndexAdapter, IndexData, JsonlLine } from "../types.js";

export class JsonV4Adapter extends AdapterBase<IndexData> {
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.jsonl", "jsonl_v4", INDEX_VERSION);
  }

  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    const lines = readline.createInterface({
      input: fs.createReadStream(this.path(), { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
    const data = this.data({});
    let ready = false;

    try {
      for await (const line of lines) {
        const row = this.parse(line);
        if (!row) continue;

        if (row.type === "meta") {
          if (row.version !== INDEX_VERSION || row.dimensions !== this.dimensions) {
            return null;
          }
          ready = true;
          data.reindexState = this.state(row.reindexState);
          continue;
        }

        if (!ready || row.type !== "entry") continue;
        if (typeof row.key === "string" && this.valid(row.entry)) {
          data.entries[row.key] = row.entry;
        }
      }
    } finally {
      lines.close();
    }

    return ready ? data : null;
  }

  async write(data: IndexData): Promise<void> {
    await this.atomic(async (tmp) => {
      let fd: number | null = null;
      const out = (text: string): void => {
        if (fd == null) return;
        const buffer = Buffer.from(text, "utf8");
        let offset = 0;
        while (offset < buffer.length) {
          offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
        }
      };
      const line = (text: string): void => {
        out(text);
        out("\n");
      };

      try {
        fd = fs.openSync(tmp, "w");
        line(
          JSON.stringify({
            type: "meta",
            version: INDEX_VERSION,
            dimensions: data.dimensions,
            reindexState: data.reindexState,
          } satisfies JsonlLine)
        );
        for (const key of Object.keys(data.entries).sort()) {
          line(
            JSON.stringify({
              type: "entry",
              key,
              entry: data.entries[key],
            } satisfies JsonlLine)
          );
        }
      } finally {
        if (fd != null) {
          fs.closeSync(fd);
        }
      }
    });
  }

  override canMigrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(adapter: TAdapter): boolean {
    return (
      super.canMigrateFrom(adapter) ||
      (adapter.kind() === "json_v3" && adapter.version() === LEGACY_JSON_VERSION)
    );
  }

  override async migrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(
    adapter: TAdapter,
    data: IndexData
  ): Promise<IndexData> {
    if (adapter.kind() === "json_v3" && adapter.version() === LEGACY_JSON_VERSION) {
      return this.migrated(data, INDEX_VERSION);
    }

    return await super.migrateFrom(adapter, data);
  }

  private parse(line: string): Partial<JsonlLine> | null {
    const text = line.trim();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as Partial<JsonlLine>;
    } catch {
      return null;
    }
  }
}