import { ChainAdapter, registerIndexAdapter } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV3Adapter } from "./jsonv3.js";
import { JsonV4Adapter } from "./jsonv4.js";
import { SqliteV4Adapter } from "./sqlitev4.js";
import type { IndexData } from "../types.js";

export class SqliteV4LocalAdapter extends ChainAdapter<IndexData, unknown> {
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