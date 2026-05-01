import { ChainAdapter, registerIndexAdapter } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV3Adapter } from "./jsonv3.js";
import type { IndexData } from "../types.js";

export class JsonIndexAdapter extends ChainAdapter<IndexData> {
  constructor(source: string, dimensions: number) {
    const target = new JsonV3Adapter(source, dimensions);
    const descriptor: AdapterSourceDescriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path(),
    };
    super(target, [new JsonV2Adapter(descriptor, dimensions)]);
  }
}

registerIndexAdapter("json_v3", JsonIndexAdapter);