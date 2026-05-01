import type {
  BedrockAgentClientFactory,
  BedrockAgentRuntimeClientFactory,
  BedrockKnowledgeBaseSyncResult,
  BedrockSyncConfig,
  KnowledgeBaseConfig,
  SearchResult,
} from "../types.js";
import { SearchAdapterBase } from "./base.js";
import { BedrockV1Adapter } from "./bedrockv1.js";

/**
 * Public Bedrock search adapter surface.
 *
 * This mirrors the local adapter pattern: the wrapper exposes the stable adapter
 * identity while the versioned implementation file owns the concrete request and
 * response schema details.
 */
export class BedrockAdapter extends SearchAdapterBase<void> {
  private readonly target: BedrockV1Adapter;

  /**
   * Build the current Bedrock adapter around the configured knowledge bases.
   *
   * The optional client factory is forwarded to the versioned implementation so
   * tests can inject a fake AWS client without altering production code paths.
   */
  constructor(
    configs: KnowledgeBaseConfig[],
    createRuntimeClient?: BedrockAgentRuntimeClientFactory,
    createAgentClient?: BedrockAgentClientFactory
  ) {
    super();
    this.target = new BedrockV1Adapter(configs, createRuntimeClient, createAgentClient);
  }

  override kind() {
    return this.target.kind();
  }

  override version() {
    return this.target.version();
  }

  async close(): Promise<void> {
    await this.target.close();
  }

  override async search(
    query: string,
    limit: number,
    _context: void,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    return await this.target.search(query, limit, undefined, signal);
  }

  async sync(config: BedrockSyncConfig): Promise<BedrockKnowledgeBaseSyncResult[]> {
    return await this.target.sync(config);
  }
}