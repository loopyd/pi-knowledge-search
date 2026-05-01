import { ChainAdapter, registerIndexAdapter } from "./base.js";
import type { AdapterSourceDescriptor } from "./base.js";
import { JsonV3Adapter } from "./jsonv3.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV4Adapter } from "./jsonv4.js";
import type { IndexData } from "../types.js";

export class JsonlIndexAdapter extends ChainAdapter<IndexData> {
  static get legacyJsonStreamingThresholdBytes(): number {
    return JsonV3Adapter.limit;
  }

  static set legacyJsonStreamingThresholdBytes(value: number) {
    JsonV3Adapter.limit = value;
  }

  constructor(source: string, dimensions: number) {
    const target = new JsonV4Adapter(source, dimensions);
    const descriptor: AdapterSourceDescriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path(),
    };
    super(target, [
      new JsonV3Adapter(descriptor, dimensions),
      new JsonV2Adapter(descriptor, dimensions),
    ]);
  }
}

registerIndexAdapter("jsonl_v4", JsonlIndexAdapter);