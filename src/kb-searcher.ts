import type { KnowledgeBaseConfig, SearchResult } from "./types.js";
import { createBedrockAgentRuntimeClient, normalizeBedrockResultLocation } from "./bedrock.js";

export type { KnowledgeBaseConfig } from "./types.js";

/**
 * Searches one or more Bedrock Knowledge Bases and returns results
 * normalized to the same SearchResult shape as local index results.
 */
export class BedrockKBSearcher {
  private configs: KnowledgeBaseConfig[];
  private clients: Map<string, { client: any; config: KnowledgeBaseConfig }> = new Map();
  private sharedClients: Map<string, any> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor(configs: KnowledgeBaseConfig[]) {
    this.configs = configs;
  }

  private async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    try {
      for (const config of this.configs) {
        const region = config.region || "us-east-1";
        const profile = config.profile || "default";
        const cacheKey = `${region}:${profile === "default" ? "default-chain" : profile}`;
        if (!this.clients.has(config.id)) {
          let client = this.sharedClients.get(cacheKey);
          if (!client) {
            client = await createBedrockAgentRuntimeClient(profile, region);
            this.sharedClients.set(cacheKey, client);
          }
          this.clients.set(config.id, { client, config });
        }
      }
    } catch (err: any) {
      console.error(`knowledge-search: Failed to initialize Bedrock KB client: ${err.message}`);
      this.configs = [];
    }
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    if (this.configs.length === 0) return [];
    await this.init();

    const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");

    const searches = this.configs.map(async (config) => {
      const entry = this.clients.get(config.id);
      if (!entry) return [];

      try {
        const command = new RetrieveCommand({
          knowledgeBaseId: config.id,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: limit,
            },
          },
        });

        const response = await entry.client.send(command, {
          abortSignal: signal,
        });

        const results: SearchResult[] = [];
        for (const result of response.retrievalResults || []) {
          const score = result.score ?? 0;
          // Bedrock scores are 0-1 relevance, same range as our cosine similarity
          if (score < 0.15) continue;

          const uri = normalizeBedrockResultLocation(result.location);

          const label = config.label ? ` [${config.label}]` : " [KB]";

          results.push({
            path: `${uri}${label}`,
            score,
            excerpt: result.content?.text || "",
            heading: "",
          });
        }
        return results;
      } catch (err: any) {
        console.error(`knowledge-search: KB ${config.id} search failed: ${err.message}`);
        return [];
      }
    });

    const allResults = (await Promise.all(searches)).flat();
    return allResults.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
