import { ChainAdapter, registerIndexAdapter } from "./base.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV3Adapter } from "./jsonv3.js";
import { JsonV4Adapter } from "./jsonv4.js";
import { SqliteV4Adapter } from "./sqlitev4.js";
import type { AdapterSourceDescriptor, IndexData } from "../types.js";

/**
 * Canonical adapter for the local SQLite-backed index.
 *
 * The main runtime sees one sqlite_local adapter, while the chain transparently
 * handles migrations from every legacy JSON family into the SQLite target.
 */
export class SqliteV4LocalAdapter extends ChainAdapter<IndexData, unknown> {
  /**
   * Build the SQLite target and bind all readable legacy fallbacks to the same source.
   *
   * This keeps migration concerns inside the adapter layer so KnowledgeIndex can
   * stay format-agnostic and operate against one clean interface.
   */
  constructor(source: string, dimensions: number) {
    const target = new SqliteV4Adapter(source, dimensions);
    const descriptor: AdapterSourceDescriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path(),
    };
    super(target, [
      new JsonV4Adapter(descriptor, dimensions),
      new JsonV3Adapter(descriptor, dimensions),
      new JsonV2Adapter(descriptor, dimensions),
    ]);
  }
}

registerIndexAdapter("sqlite_local", SqliteV4LocalAdapter);