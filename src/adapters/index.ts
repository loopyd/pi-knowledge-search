/* Public export surface for the adapter layer used by runtime code and tests. */
export { ChainAdapter, SearchAdapterBase, createIndexAdapter, dotProduct } from "./base.js";
export { BedrockAdapter } from "./bedrock.js";
export { BedrockV1Adapter } from "./bedrockv1.js";
export { JsonIndexAdapter } from "./json.js";
export { JsonlIndexAdapter } from "./jsonl.js";
export { SqliteV4LocalAdapter } from "./sqlitev4-local.js";
export { SqliteV4Adapter } from "./sqlitev4.js";
export { JsonV2Adapter } from "./jsonv2.js";
export { JsonV3Adapter } from "./jsonv3.js";
export { JsonV4Adapter } from "./jsonv4.js";
export { createEmptyIndexData, INDEX_VERSION } from "./base.js";
export type { IndexAdapter, IndexData, IndexEntry, KbAdapter, SearchAdapter, SqliteStore } from "../types.js";