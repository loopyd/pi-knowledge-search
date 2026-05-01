import { ChainAdapter, registerIndexAdapter } from "./base.js";
import { JsonV3Adapter } from "./jsonv3.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV4Adapter } from "./jsonv4.js";
import type { AdapterSourceDescriptor, IndexData } from "../types.js";

/**
 * Canonical adapter for the JSONL v4 storage format.
 *
 * This is the preferred file-backed format for current indexes. The chain keeps
 * v3 JSON and v2 JSON readable while exposing the normalized v4 interface to the
 * rest of the runtime.
 */
export class JsonlIndexAdapter extends ChainAdapter<IndexData> {
  /* Expose one shared threshold for all legacy whole-object JSON readers. */
  static get threshold(): number {
    return JsonV3Adapter.limit;
  }

  /* Keep v2 and v3 on the same large-file streaming cutoff. */
  static set threshold(value: number) {
    JsonV3Adapter.limit = value;
    JsonV2Adapter.limit = value;
  }

  /**
   * Build the JSONL v4 target and bind both legacy JSON fallbacks to the same source.
   *
   * The resulting chain lets callers treat all JSON-backed indexes as one clean
   * adapter even though migration may hop through multiple historical revisions.
   */
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