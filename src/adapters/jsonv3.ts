import * as fs from "node:fs";
import Assembler from "stream-json/assembler.js";
import makeParser from "stream-json/index.js";
import { AdapterBase, JSON_V2_VERSION, LEGACY_JSON_VERSION } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import type { IndexAdapter, IndexData, JsonV3Data } from "../types.js";

export class JsonV3Adapter extends AdapterBase<IndexData> {
  static limit = 256 * 1024 * 1024;

  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.json", "json_v3", LEGACY_JSON_VERSION);
  }

  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    try {
      let raw: JsonV3Data | null = null;
      const size = fs.statSync(this.path()).size;
      if (size >= JsonV3Adapter.limit) {
        raw = await this.stream(this.path());
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

  override canMigrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(adapter: TAdapter): boolean {
    return (
      super.canMigrateFrom(adapter) ||
      (adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION)
    );
  }

  override async migrateFrom<TAdapter extends IndexAdapter<IndexData, unknown>>(
    adapter: TAdapter,
    data: IndexData
  ): Promise<IndexData> {
    if (adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION) {
      return this.migrated(data, LEGACY_JSON_VERSION);
    }

    return await super.migrateFrom(adapter, data);
  }

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

  private stream(file: string): Promise<JsonV3Data | null> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
      const parser = makeParser();
      const assembler = Assembler.connectTo(parser);

      assembler.on("done", (result) => {
        resolve(result.current as JsonV3Data);
      });
      stream.on("error", reject);
      parser.on("error", reject);
      stream.pipe(parser);
    });
  }

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