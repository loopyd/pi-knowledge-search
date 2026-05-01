import { ChainAdapter, registerIndexAdapter } from "./base.js";
import { JsonV2Adapter } from "./jsonv2.js";
import { JsonV3Adapter } from "./jsonv3.js";
import type { AdapterSourceDescriptor, IndexData } from "../types.js";

/**
 * Canonical adapter for the legacy `.json` storage family.
 *
 * Callers interact with this as the v3 JSON adapter, while the chain keeps v2
 * compatibility hidden behind the shared IndexAdapter interface.
 */
export class JsonIndexAdapter extends ChainAdapter<IndexData> {
  /**
   * Build a v3 JSON target and wire the v2 fallback to the same logical source.
   *
   * The descriptor preserves the selected file path so migrations happen against
   * sibling files instead of drifting to default names.
   */
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