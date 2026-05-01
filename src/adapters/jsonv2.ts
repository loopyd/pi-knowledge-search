import * as fs from "node:fs";
import { AdapterBase, JSON_V2_VERSION, registerIndexAdapter } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import type { IndexData, JsonV2Data, LegacyIndexEntry } from "../types.js";

export class JsonV2Adapter extends AdapterBase<IndexData> {
  constructor(source: string | AdapterSourceDescriptor, dimensions: number) {
    super(source, dimensions, "index.json", "json_v2", JSON_V2_VERSION);
  }

  async read(): Promise<IndexData | null> {
    if (!this.exists()) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(this.path(), "utf-8")) as JsonV2Data;
      if (!this.match(raw)) {
        return null;
      }
      return this.inflate(raw.entries ?? {});
    } catch {
      return null;
    }
  }

  async write(): Promise<void> {
    throw new Error("json_v2 is a read-only legacy adapter");
  }

  private match(value: JsonV2Data | null): value is JsonV2Data {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (value.version !== JSON_V2_VERSION || value.dimensions !== this.dimensions) {
      return false;
    }

    return this.legacy(value.entries ?? {});
  }

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