import * as fs from "node:fs";
import Assembler from "stream-json/assembler.js";
import makeParser from "stream-json/index.js";
import { AdapterBase, JSON_STREAM_CHUNK_BYTES, JSON_V2_VERSION, LEGACY_JSON_VERSION } from "./base.js";
import type { AdapterSourceDescriptor, IndexAdapter, IndexData, JsonV3Data } from "../types.js";

/**
 * Adapter for the v3 legacy JSON object format.
 *
 * v3 is still a whole-file JSON document, so it keeps the same size-gated
 * streaming safety net as the main index-store fix while preserving the older
 * on-disk layout for migration compatibility.
 */
export class JsonV3Adapter extends AdapterBase<IndexData> {
  /* Fall back to streaming before V8 string limits can crash large legacy loads. */
  static limit = 256 * 1024 * 1024;

  /**
   * Wrap a v3 JSON source or an inherited descriptor from a chain adapter.
   *
   * Descriptors keep the adapter wired to the same logical source path when the
   * chain is probing older sibling formats during migration.
   */
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.json", "json_v3", LEGACY_JSON_VERSION);
  }

  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    try {
      let raw: JsonV3Data | null = null;
      const size = fs.statSync(this.path()).size;
      if (size >= JsonV3Adapter.limit) {
        raw = await new Promise<JsonV3Data | null>((resolve, reject) => {
          const stream = fs.createReadStream(this.path(), {
            highWaterMark: JSON_STREAM_CHUNK_BYTES,
          });
          const parser = makeParser();
          const assembler = Assembler.connectTo(parser);

          assembler.on("done", (result) => {
            resolve(result.current as JsonV3Data);
          });
          stream.on("error", reject);
          parser.on("error", reject);
          stream.pipe(parser);
        });
      } else {
        raw = JSON.parse(fs.readFileSync(this.path(), "utf-8")) as JsonV3Data;
      }

      if (!this.match(raw)) {
        return null;
      }

      return this.data(raw.entries ?? {}, undefined, LEGACY_JSON_VERSION);
    } catch {
      return null;
    }
  }

  /* Prefer the fast stringify path and only stream out key-by-key on RangeError. */
  async write(data: IndexData): Promise<void> {
    const raw: JsonV3Data = {
      version: LEGACY_JSON_VERSION,
      dimensions: this.dimensions,
      entries: data.entries,
    };

    await this.atomic(async (tmp) => {
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(raw));
      } catch (error) {
        if (error instanceof RangeError) {
          await this.dump(tmp, raw);
          return;
        }
        throw error;
      }
    });
  }

  override accepts<TAdapter extends IndexAdapter<IndexData, unknown>>(adapter: TAdapter): boolean {
    return (
      super.accepts(adapter) ||
      (adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION)
    );
  }

  override async migrate<TAdapter extends IndexAdapter<IndexData, unknown>>(
    adapter: TAdapter,
    data: IndexData
  ): Promise<IndexData> {
    if (adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION) {
      return this.migrated(data, LEGACY_JSON_VERSION);
    }

    return await super.migrate(adapter, data);
  }

  /* Validate the legacy v3 shape before normalizing it back into the in-memory form. */
  private match(value: JsonV3Data | null): value is JsonV3Data {
    return Boolean(
      value &&
        value.version === LEGACY_JSON_VERSION &&
        value.dimensions === this.dimensions &&
        (value.entries === undefined ||
          (typeof value.entries === "object" &&
            value.entries !== null &&
            !Array.isArray(value.entries)))
    );
  }

  /* Stream the legacy object out incrementally when stringify would exceed V8 string limits. */
  private async dump(file: string, data: JsonV3Data): Promise<void> {
    const stream = fs.createWriteStream(file);
    let fail: Error | null = null;
    stream.once("error", (error) => {
      fail = error;
    });

    const write = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (fail) {
          reject(fail);
          return;
        }
        if (stream.write(chunk)) {
          resolve();
        } else {
          stream.once("drain", () => (fail ? reject(fail) : resolve()));
        }
      });

    try {
      await write(
        `{"version":${JSON.stringify(data.version)},` +
          `"dimensions":${JSON.stringify(data.dimensions)},` +
          `"entries":{`
      );
      let first = true;
      for (const key of Object.keys(data.entries ?? {})) {
        const prefix = first ? "" : ",";
        first = false;
        await write(`${prefix}${JSON.stringify(key)}:${JSON.stringify(data.entries?.[key])}`);
      }
      await write("}}");
    } catch (error) {
      stream.destroy();
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}