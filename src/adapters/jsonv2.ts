import * as fs from "node:fs";
import Assembler from "stream-json/assembler.js";
import makeParser from "stream-json/index.js";
import { AdapterBase, JSON_STREAM_CHUNK_BYTES, JSON_V2_VERSION, registerIndexAdapter } from "./base.js";
import type { AdapterSourceDescriptor, IndexData, JsonV2Data, LegacyIndexEntry } from "../types.js";

/**
 * Read-only adapter for the original v2 JSON index format.
 *
 * This format stores one whole JSON object on disk and predates chunk heading
 * metadata. The adapter inflates that legacy shape into the normalized in-memory
 * representation expected by newer adapters and the main index runtime.
 */
export class JsonV2Adapter extends AdapterBase<IndexData> {
  /* Match the size-gated legacy JSON streaming cutoff introduced for large indexes. */
  static limit = 256 * 1024 * 1024;

  /**
   * Wrap a concrete v2 JSON source.
   *
   * The source may be a direct path chosen by configuration or a descriptor
   * inherited from a chain adapter that needs to probe a sibling legacy file.
   */
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.json", "json_v2", JSON_V2_VERSION);
  }

  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    try {
      let raw: JsonV2Data | null = null;
      const size = fs.statSync(this.path()).size;
      if (size >= JsonV2Adapter.limit) {
        raw = await new Promise<JsonV2Data | null>((resolve, reject) => {
          const stream = fs.createReadStream(this.path(), {
            highWaterMark: JSON_STREAM_CHUNK_BYTES,
          });
          const parser = makeParser();
          const assembler = Assembler.connectTo(parser);

          assembler.on("done", (result) => {
            resolve(result.current as JsonV2Data);
          });
          stream.on("error", reject);
          parser.on("error", reject);
          stream.pipe(parser);
        });
      } else {
        raw = JSON.parse(fs.readFileSync(this.path(), "utf-8")) as JsonV2Data;
      }

      if (!this.match(raw)) {
        return null;
      }
      return this.inflate(raw.entries ?? {});
    } catch {
      return null;
    }
  }

  /* v2 is retained purely for backward-compatible reads; writes must migrate elsewhere. */
  async write(): Promise<void> {
    throw new Error("json_v2 is a read-only legacy adapter");
  }

  /* Accept only the exact legacy schema and dimensionality this adapter can inflate safely. */
  private match(value: JsonV2Data | null): value is JsonV2Data {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (value.version !== JSON_V2_VERSION || value.dimensions !== this.dimensions) {
      return false;
    }

    return this.legacy(value.entries ?? {});
  }

  /* Validate the pre-heading legacy entry shape before inflating it. */
  private legacy(entries: Record<string, LegacyIndexEntry>): boolean {
    return Object.values(entries).every((entry) => {
      return (
        typeof entry.relPath === "string" &&
        typeof entry.sourceDir === "string" &&
        typeof entry.mtime === "number" &&
        typeof entry.excerpt === "string" &&
        Array.isArray(entry.vector) &&
        entry.vector.every((value) => typeof value === "number") &&
        entry.vector.length === this.dimensions
      );
    });
  }

  /* Synthesize the heading and chunk metadata that did not exist in v2 on disk. */
  private inflate(entries: Record<string, LegacyIndexEntry>): IndexData {
    const data = this.data({}, "running", JSON_V2_VERSION);
    for (const [absPath, entry] of Object.entries(entries)) {
      data.entries[`${absPath}#0`] = {
        ...entry,
        heading: "intro",
        chunkIndex: 0,
      };
    }
    return data;
  }
}

registerIndexAdapter("json_v2", JsonV2Adapter);