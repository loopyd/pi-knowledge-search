import type { ProviderConfig } from "./config";
import {
  countUnpairedSurrogates,
  logDebug,
  logError,
  logWarn,
} from "./logging";

/**
 * Unified embedding interface. Implementations for OpenAI, Bedrock, and Ollama.
 */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency?: number
  ): Promise<(number[] | null)[]>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmbedder(
  config: ProviderConfig,
  dimensions: number
): Embedder {
  switch (config.type) {
    case "openai":
      return new OpenAIEmbedder(config.apiKey, config.model, dimensions, undefined);
    case "openai-compatible":
      return new OpenAIEmbedder(
        config.apiKey ?? "",
        config.model,
        dimensions,
        config.baseUrl
      );
    case "bedrock":
      return new BedrockEmbedder(
        config.profile,
        config.region,
        config.model,
        dimensions
      );
    case "ollama":
      return new OllamaEmbedder(config.url, config.model);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Truncate to stay within token limits. Conservative: ~10K chars ≈ 4-6K tokens. */
function truncate(text: string, maxChars = 10000): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function summarizeBatch(texts: string[]): {
  textCount: number;
  minChars: number;
  maxChars: number;
  avgChars: number;
  totalChars: number;
  unpairedSurrogates: number;
} {
  if (texts.length === 0) {
    return {
      textCount: 0,
      minChars: 0,
      maxChars: 0,
      avgChars: 0,
      totalChars: 0,
      unpairedSurrogates: 0,
    };
  }

  let minChars = Number.POSITIVE_INFINITY;
  let maxChars = 0;
  let totalChars = 0;
  let unpairedSurrogates = 0;

  for (const text of texts) {
    const length = text.length;
    totalChars += length;
    if (length < minChars) minChars = length;
    if (length > maxChars) maxChars = length;
    unpairedSurrogates += countUnpairedSurrogates(text);
  }

  return {
    textCount: texts.length,
    minChars,
    maxChars,
    avgChars: Math.round(totalChars / texts.length),
    totalChars,
    unpairedSurrogates,
  };
}

const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff for 429s

/** Retry a fetch-based operation on 429 rate-limit errors with exponential backoff. */
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const is429 =
        err?.message?.includes("429") ||
        err?.name === "ThrottlingException" ||
        err?.$metadata?.httpStatusCode === 429;
      if (is429 && attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.error(
          `knowledge-search: ${label} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
        );
        logWarn("embedder", "rate limited", {
          label,
          delay,
          attempt: attempt + 1,
          maxAttempts: RETRY_DELAYS.length,
        });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/** Run an async function over an array with bounded concurrency. */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new Error("Aborted");
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

interface AdaptiveBatchMeta {
  depth: number;
  firstIndex: number;
  lastIndex: number;
}

interface AdaptiveBatchOptions {
  scope: string;
  providerLabel: string;
  maxBatchSize: number;
  signal?: AbortSignal;
  context?: Record<string, unknown>;
  prepareText?: (text: string) => string;
  requestBatch: (
    batch: string[],
    signal: AbortSignal | undefined,
    meta: AdaptiveBatchMeta
  ) => Promise<(number[] | null)[]>;
}

async function embedBatchWithAdaptiveFallback(
  texts: string[],
  options: AdaptiveBatchOptions
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(texts.length).fill(null);

  const resolveSubBatch = async (
    batch: string[],
    indices: number[],
    depth: number
  ): Promise<void> => {
    if (batch.length === 0) return;
    if (options.signal?.aborted) throw new Error("Aborted");

    const firstIndex = indices[0] ?? 0;
    const lastIndex = indices[indices.length - 1] ?? firstIndex;
    const summary = summarizeBatch(batch);

    logDebug(options.scope, "batch start", {
      provider: options.providerLabel,
      depth,
      firstIndex,
      lastIndex,
      batchSize: batch.length,
      summary,
      ...(options.context ?? {}),
    });

    if (summary.unpairedSurrogates > 0) {
      logWarn(options.scope, "batch contains unpaired surrogate code points", {
        provider: options.providerLabel,
        depth,
        firstIndex,
        lastIndex,
        unpairedSurrogates: summary.unpairedSurrogates,
        ...(options.context ?? {}),
      });
    }

    try {
      const vectors = await options.requestBatch(batch, options.signal, {
        depth,
        firstIndex,
        lastIndex,
      });

      if (vectors.length !== batch.length) {
        logWarn(options.scope, "batch response size mismatch", {
          provider: options.providerLabel,
          depth,
          firstIndex,
          lastIndex,
          expected: batch.length,
          received: vectors.length,
          ...(options.context ?? {}),
        });
      }

      const mapLength = Math.min(vectors.length, indices.length);
      for (let i = 0; i < mapLength; i++) {
        results[indices[i]] = vectors[i];
      }
      return;
    } catch (err: any) {
      if (options.signal?.aborted || err?.message === "Aborted") {
        throw err;
      }

      if (batch.length === 1) {
        const idx = indices[0];
        results[idx] = null;
        console.error(`${options.providerLabel} batch request failed: ${err.message}`);
        logError(options.scope, "single-item batch failed", {
          provider: options.providerLabel,
          depth,
          index: idx,
          error: err?.message,
          stack: err?.stack,
          ...(options.context ?? {}),
        });
        return;
      }

      const splitAt = Math.floor(batch.length / 2);
      logWarn(options.scope, "adaptive split fallback", {
        provider: options.providerLabel,
        depth,
        batchSize: batch.length,
        leftSize: splitAt,
        rightSize: batch.length - splitAt,
        firstIndex,
        lastIndex,
        error: err?.message,
        ...(options.context ?? {}),
      });

      await resolveSubBatch(batch.slice(0, splitAt), indices.slice(0, splitAt), depth + 1);
      await resolveSubBatch(batch.slice(splitAt), indices.slice(splitAt), depth + 1);
    }
  };

  for (let i = 0; i < texts.length; i += options.maxBatchSize) {
    if (options.signal?.aborted) throw new Error("Aborted");
    const source = texts.slice(i, i + options.maxBatchSize);
    const batch = options.prepareText ? source.map(options.prepareText) : source;
    const indices = Array.from({ length: batch.length }, (_, j) => i + j);
    await resolveSubBatch(batch, indices, 0);
  }

  return results;
}

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible)
// ---------------------------------------------------------------------------

class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  private dimensions: number;
  private baseUrl: string;

  private async requestBatch(
    batch: string[],
    signal: AbortSignal | undefined,
    meta: { depth: number; firstIndex: number; lastIndex: number }
  ): Promise<(number[] | null)[]> {
    return withRateLimitRetry(async () => {
      const payload = {
        input: batch,
        model: this.model,
        dimensions: this.dimensions,
      };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      logDebug("embedder.openai", "request payload prepared", {
        endpoint: this.baseUrl,
        depth: meta.depth,
        firstIndex: meta.firstIndex,
        lastIndex: meta.lastIndex,
        payloadSizeBytes,
      });

      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!res.ok) {
        const body = await res.text();
        logWarn("embedder.openai", "request failed", {
          endpoint: this.baseUrl,
          depth: meta.depth,
          firstIndex: meta.firstIndex,
          lastIndex: meta.lastIndex,
          status: res.status,
          statusText: res.statusText,
          bodyPreview: body.slice(0, 500),
          batchSize: batch.length,
        });
        throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
      }

      const responseJson = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      const vectors: (number[] | null)[] = new Array(batch.length).fill(null);
      for (const item of responseJson.data) {
        if (item.index < 0 || item.index >= vectors.length) continue;
        vectors[item.index] = item.embedding;
      }

      logDebug("embedder.openai", "request succeeded", {
        endpoint: this.baseUrl,
        depth: meta.depth,
        firstIndex: meta.firstIndex,
        lastIndex: meta.lastIndex,
        vectorsReturned: responseJson.data.length,
      });

      return vectors;
    }, "OpenAI embed");
  }

  constructor(apiKey: string, model: string, dimensions: number, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/v1/embeddings` : "https://api.openai.com/v1/embeddings";
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed — provider returned no vector");
    return results[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal
  ): Promise<(number[] | null)[]> {
    return embedBatchWithAdaptiveFallback(texts, {
      scope: "embedder.openai",
      providerLabel: this.baseUrl.includes("api.openai.com") ? "OpenAI" : "Embedding",
      maxBatchSize: 100,
      signal,
      prepareText: (text) => truncate(text),
      context: {
        endpoint: this.baseUrl,
        model: this.model,
        dimensions: this.dimensions,
      },
      requestBatch: (batch, requestSignal, meta) =>
        this.requestBatch(batch, requestSignal, meta),
    });
  }
}

// ---------------------------------------------------------------------------
// Bedrock (Titan)
// ---------------------------------------------------------------------------

class BedrockEmbedder implements Embedder {
  private client: any; // Lazy-loaded to avoid hard dep if not using Bedrock
  private model: string;
  private dimensions: number;
  private clientPromise: Promise<any>;

  constructor(
    profile: string,
    region: string,
    model: string,
    dimensions: number
  ) {
    this.model = model;
    this.dimensions = dimensions;

    // Lazy-load the AWS SDK — it's an optional dependency
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import(
        "@aws-sdk/client-bedrock-runtime"
      );
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile }),
      });
    })();
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed — provider returned no vector");
    return results[0];
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency = 10
  ): Promise<(number[] | null)[]> {
    const client = await this.clientPromise;

    return embedBatchWithAdaptiveFallback(texts, {
      scope: "embedder.bedrock",
      providerLabel: "Bedrock",
      maxBatchSize: 100,
      signal,
      prepareText: (text) => truncate(text),
      context: {
        model: this.model,
        dimensions: this.dimensions,
        concurrency,
      },
      requestBatch: (batch, requestSignal) =>
        parallelMap(
          batch,
          async (text) => {
            try {
              return await this.callBedrock(client, text);
            } catch (err: any) {
              console.error(
                `Bedrock embedding failed (${text.slice(0, 50)}...): ${err.message}`
              );
              logError("embedder.bedrock", "item failed", {
                model: this.model,
                error: err?.message,
              });
              return null;
            }
          },
          concurrency,
          requestSignal
        ),
    });
  }

  private async callBedrock(client: any, text: string): Promise<number[]> {
    return withRateLimitRetry(async () => {
      const { InvokeModelCommand } = await import(
        "@aws-sdk/client-bedrock-runtime"
      );

      const body = JSON.stringify({
        inputText: truncate(text),
        dimensions: this.dimensions,
        normalize: true,
      });

      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      if (!responseBody.embedding) {
        throw new Error(
          "Unexpected Bedrock response: " +
            JSON.stringify(responseBody).slice(0, 200)
        );
      }
      return responseBody.embedding;
    }, "Bedrock embed");
  }
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

class OllamaEmbedder implements Embedder {
  private url: string;
  private model: string;

  constructor(url: string, model: string) {
    this.url = url.replace(/\/$/, "");
    this.model = model;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    return withRateLimitRetry(async () => {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncate(text) }),
        signal,
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama API ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as { embeddings: number[][] };
      return json.embeddings[0];
    }, "Ollama embed");
  }

  async embedBatch(
    texts: string[],
    signal?: AbortSignal,
    concurrency = 4
  ): Promise<(number[] | null)[]> {
    return embedBatchWithAdaptiveFallback(texts, {
      scope: "embedder.ollama",
      providerLabel: "Ollama",
      maxBatchSize: 100,
      signal,
      prepareText: (text) => truncate(text),
      context: {
        url: this.url,
        model: this.model,
        concurrency,
      },
      requestBatch: (batch, requestSignal) =>
        parallelMap(
          batch,
          async (text) => {
            try {
              return await this.embed(text, requestSignal);
            } catch (err: any) {
              console.error(
                `Ollama embedding failed (${text.slice(0, 50)}...): ${err.message}`
              );
              logError("embedder.ollama", "item failed", {
                url: this.url,
                model: this.model,
                error: err?.message,
              });
              return null;
            }
          },
          concurrency,
          requestSignal
        ),
    });
  }
}
