#!/usr/bin/env node

// src/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
var CONFIG_PATH = process.env.KNOWLEDGE_SEARCH_CONFIG || path.join(process.env.HOME || "/tmp", ".pi", "knowledge-search.json");
function loadConfig() {
  let file = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
    }
  }
  const envDirs = process.env.KNOWLEDGE_SEARCH_DIRS;
  const hasKBs = (file?.knowledgeBases?.length ?? 0) > 0;
  if (!file && !envDirs) {
    return null;
  }
  const home = process.env.HOME || "/tmp";
  const resolvePath = (p) => p.replace(/^~/, home);
  const dirs = (envDirs ? envDirs.split(",").map((d) => d.trim()) : file?.dirs ?? []).map(resolvePath).filter(Boolean);
  if (dirs.length === 0 && !hasKBs) return null;
  const fileExtensions = envStr("KNOWLEDGE_SEARCH_EXTENSIONS")?.split(",").map((e) => e.trim()) ?? file?.fileExtensions ?? [".md", ".txt"];
  const excludeDirs = envStr("KNOWLEDGE_SEARCH_EXCLUDE")?.split(",").map((d) => d.trim()) ?? file?.excludeDirs ?? ["node_modules", ".git", ".obsidian", ".trash"];
  const dimensions = envInt("KNOWLEDGE_SEARCH_DIMENSIONS") ?? file?.dimensions ?? 512;
  const providerType = envStr("KNOWLEDGE_SEARCH_PROVIDER") ?? file?.provider?.type ?? // Convenience default: if OPENAI_API_KEY is exported and nothing else
  // is configured, assume the user wants the openai provider.
  (process.env.OPENAI_API_KEY ? "openai" : void 0);
  let provider = null;
  if (providerType) {
    switch (providerType) {
      case "openai": {
        if (file?.provider?.type === "openai" && file.provider.baseUrl) {
          throw new Error(
            'Custom baseUrl is not supported on provider type "openai" (it would be silently ignored and requests would hit api.openai.com). Change "type" to "openai-compatible" to use a custom endpoint.'
          );
        }
        const apiKey = envStr("KNOWLEDGE_SEARCH_OPENAI_API_KEY") ?? process.env.OPENAI_API_KEY ?? (file?.provider?.type === "openai" ? file.provider.apiKey : void 0);
        if (!apiKey) {
          throw new Error(
            "OpenAI API key required. Run /knowledge-search-setup or set OPENAI_API_KEY."
          );
        }
        provider = {
          type: "openai",
          apiKey,
          model: envStr("KNOWLEDGE_SEARCH_OPENAI_MODEL") ?? (file?.provider?.type === "openai" ? file.provider.model : void 0) ?? "text-embedding-3-small"
        };
        break;
      }
      case "openai-compatible": {
        const compatApiKey = envStr("KNOWLEDGE_SEARCH_COMPAT_API_KEY") ?? (file?.provider?.type === "openai-compatible" ? file.provider.apiKey : void 0);
        const compatBaseUrl = envStr("KNOWLEDGE_SEARCH_COMPAT_BASE_URL") ?? (file?.provider?.type === "openai-compatible" ? file.provider.baseUrl : void 0);
        if (!compatBaseUrl) {
          throw new Error(
            "OpenAI-compatible requires baseUrl. Set KNOWLEDGE_SEARCH_COMPAT_BASE_URL or provide it in config."
          );
        }
        provider = {
          type: "openai-compatible",
          apiKey: compatApiKey,
          model: envStr("KNOWLEDGE_SEARCH_COMPAT_MODEL") ?? (file?.provider?.type === "openai-compatible" ? file.provider.model : void 0) ?? "text-embedding-3-small",
          baseUrl: compatBaseUrl
        };
        break;
      }
      case "bedrock":
        provider = {
          type: "bedrock",
          profile: envStr("KNOWLEDGE_SEARCH_BEDROCK_PROFILE") ?? (file?.provider?.type === "bedrock" ? file.provider.profile : void 0) ?? "default",
          region: envStr("KNOWLEDGE_SEARCH_BEDROCK_REGION") ?? (file?.provider?.type === "bedrock" ? file.provider.region : void 0) ?? "us-east-1",
          model: envStr("KNOWLEDGE_SEARCH_BEDROCK_MODEL") ?? (file?.provider?.type === "bedrock" ? file.provider.model : void 0) ?? "amazon.titan-embed-text-v2:0"
        };
        break;
      case "ollama":
        provider = {
          type: "ollama",
          url: envStr("KNOWLEDGE_SEARCH_OLLAMA_URL") ?? (file?.provider?.type === "ollama" ? file.provider.url : void 0) ?? "http://localhost:11434",
          model: envStr("KNOWLEDGE_SEARCH_OLLAMA_MODEL") ?? (file?.provider?.type === "ollama" ? file.provider.model : void 0) ?? "nomic-embed-text"
        };
        break;
      default:
        throw new Error(
          `Unknown provider: "${providerType}". Use "openai", "openai-compatible", "bedrock", or "ollama".`
        );
    }
  }
  const indexDir = envStr("KNOWLEDGE_SEARCH_INDEX_DIR") ?? path.join(home, ".pi", "knowledge-search");
  const logFile = envStr("KNOWLEDGE_SEARCH_LOG_FILE") ?? file?.logFile ?? path.join(indexDir, "logs", "knowledge-search.log");
  const verboseLogging = envBool("KNOWLEDGE_SEARCH_VERBOSE") ?? file?.verboseLogging ?? true;
  const quarantineEnabled = envBool("KNOWLEDGE_SEARCH_QUARANTINE_ENABLED") ?? file?.quarantineEnabled ?? true;
  return {
    dirs,
    fileExtensions,
    excludeDirs,
    dimensions,
    provider,
    indexDir,
    logFile,
    verboseLogging,
    quarantineEnabled,
    knowledgeBases: file?.knowledgeBases ?? []
  };
}
function envStr(key) {
  const v = process.env[key]?.trim();
  return v || void 0;
}
function envInt(key) {
  const v = envStr(key);
  return v ? parseInt(v, 10) : void 0;
}
function envBool(key) {
  const v = envStr(key);
  if (!v) return void 0;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  return void 0;
}

// src/logging.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
function parseFlag(value, defaultValue) {
  if (value == null || value.trim() === "") return defaultValue;
  return /^(1|true|yes|on|debug|verbose)$/i.test(value.trim());
}
function resolveSettings() {
  const home = process.env.HOME || "/tmp";
  const defaultDir = path2.join(home, ".pi", "knowledge-search", "logs");
  const logDir = process.env.KNOWLEDGE_SEARCH_LOG_DIR || defaultDir;
  const logFile = process.env.KNOWLEDGE_SEARCH_LOG_FILE || path2.join(logDir, "knowledge-search.log");
  return {
    verboseEnabled: parseFlag(process.env.KNOWLEDGE_SEARCH_VERBOSE, true),
    logFile
  };
}
var initializedPaths = /* @__PURE__ */ new Set();
function ensureLogFile(logFile) {
  if (initializedPaths.has(logFile)) return;
  initializedPaths.add(logFile);
  const logDir = path2.dirname(logFile);
  try {
    fs2.mkdirSync(logDir, { recursive: true });
  } catch {
  }
}
function redact(value) {
  return value.replace(/Bearer\s+[A-Za-z0-9_\-.]+/g, "Bearer [REDACTED]").replace(/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"[REDACTED]"').replace(/OPENAI_API_KEY=\S+/g, "OPENAI_API_KEY=[REDACTED]");
}
function safeSerialize(meta) {
  if (meta == null) return void 0;
  try {
    const text = JSON.stringify(meta);
    return text.length > 4e3 ? `${text.slice(0, 4e3)}...` : text;
  } catch (err) {
    return JSON.stringify({
      serializationError: err?.message ?? "unknown"
    });
  }
}
function appendLine(level, scope, message, meta) {
  const settings = resolveSettings();
  ensureLogFile(settings.logFile);
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const record = {
    ts,
    level,
    pid: process.pid,
    scope,
    message: redact(message)
  };
  const serializedMeta = safeSerialize(meta);
  if (serializedMeta) {
    record.meta = serializedMeta;
  }
  try {
    fs2.appendFileSync(settings.logFile, `${JSON.stringify(record)}
`, "utf8");
  } catch {
  }
}
function getKnowledgeSearchLogPath() {
  return resolveSettings().logFile;
}
function logDebug(scope, message, meta) {
  if (!resolveSettings().verboseEnabled) return;
  appendLine("debug", scope, message, meta);
}
function logInfo(scope, message, meta) {
  if (!resolveSettings().verboseEnabled) return;
  appendLine("info", scope, message, meta);
}
function logWarn(scope, message, meta) {
  appendLine("warn", scope, message, meta);
}
function logError(scope, message, meta) {
  appendLine("error", scope, message, meta);
}
function countUnpairedSurrogates(text) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 55296 && code <= 56319;
    const isLow = code >= 56320 && code <= 57343;
    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      const nextIsLow = next >= 56320 && next <= 57343;
      if (!nextIsLow) {
        count++;
        continue;
      }
      i++;
      continue;
    }
    if (isLow) {
      count++;
    }
  }
  return count;
}

// src/embedder.ts
function createEmbedder(config2, dimensions) {
  switch (config2.type) {
    case "openai":
      return new OpenAIEmbedder(config2.apiKey, config2.model, dimensions, void 0);
    case "openai-compatible":
      return new OpenAIEmbedder(
        config2.apiKey ?? "",
        config2.model,
        dimensions,
        config2.baseUrl
      );
    case "bedrock":
      return new BedrockEmbedder(
        config2.profile,
        config2.region,
        config2.model,
        dimensions
      );
    case "ollama":
      return new OllamaEmbedder(config2.url, config2.model);
  }
}
function truncate(text, maxChars = 1e4) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
function summarizeBatch(texts) {
  if (texts.length === 0) {
    return {
      textCount: 0,
      minChars: 0,
      maxChars: 0,
      avgChars: 0,
      totalChars: 0,
      unpairedSurrogates: 0
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
    unpairedSurrogates
  };
}
var RETRY_DELAYS = [1e3, 2e3, 4e3];
async function withRateLimitRetry(fn, label) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.message?.includes("429") || err?.name === "ThrottlingException" || err?.$metadata?.httpStatusCode === 429;
      if (is429 && attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.error(
          `knowledge-search: ${label} rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})`
        );
        logWarn("embedder", "rate limited", {
          label,
          delay,
          attempt: attempt + 1,
          maxAttempts: RETRY_DELAYS.length
        });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
async function parallelMap(items, fn, concurrency, signal) {
  const results = new Array(items.length);
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
async function embedBatchWithAdaptiveFallback(texts, options) {
  const results = new Array(texts.length).fill(null);
  const resolveSubBatch = async (batch, indices, depth) => {
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
      ...options.context ?? {}
    });
    if (summary.unpairedSurrogates > 0) {
      logWarn(options.scope, "batch contains unpaired surrogate code points", {
        provider: options.providerLabel,
        depth,
        firstIndex,
        lastIndex,
        unpairedSurrogates: summary.unpairedSurrogates,
        ...options.context ?? {}
      });
    }
    try {
      const vectors = await options.requestBatch(batch, options.signal, {
        depth,
        firstIndex,
        lastIndex
      });
      if (vectors.length !== batch.length) {
        logWarn(options.scope, "batch response size mismatch", {
          provider: options.providerLabel,
          depth,
          firstIndex,
          lastIndex,
          expected: batch.length,
          received: vectors.length,
          ...options.context ?? {}
        });
      }
      const mapLength = Math.min(vectors.length, indices.length);
      for (let i = 0; i < mapLength; i++) {
        results[indices[i]] = vectors[i];
      }
      return;
    } catch (err) {
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
          ...options.context ?? {}
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
        ...options.context ?? {}
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
var OpenAIEmbedder = class {
  apiKey;
  model;
  dimensions;
  baseUrl;
  async requestBatch(batch, signal, meta) {
    return withRateLimitRetry(async () => {
      const payload = {
        input: batch,
        model: this.model,
        dimensions: this.dimensions
      };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
      logDebug("embedder.openai", "request payload prepared", {
        endpoint: this.baseUrl,
        depth: meta.depth,
        firstIndex: meta.firstIndex,
        lastIndex: meta.lastIndex,
        payloadSizeBytes
      });
      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          ...this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal
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
          batchSize: batch.length
        });
        throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
      }
      const responseJson = await res.json();
      const vectors = new Array(batch.length).fill(null);
      for (const item of responseJson.data) {
        if (item.index < 0 || item.index >= vectors.length) continue;
        vectors[item.index] = item.embedding;
      }
      logDebug("embedder.openai", "request succeeded", {
        endpoint: this.baseUrl,
        depth: meta.depth,
        firstIndex: meta.firstIndex,
        lastIndex: meta.lastIndex,
        vectorsReturned: responseJson.data.length
      });
      return vectors;
    }, "OpenAI embed");
  }
  constructor(apiKey, model, dimensions, baseUrl) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.baseUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/v1/embeddings` : "https://api.openai.com/v1/embeddings";
  }
  async embed(text, signal) {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal) {
    return embedBatchWithAdaptiveFallback(texts, {
      scope: "embedder.openai",
      providerLabel: this.baseUrl.includes("api.openai.com") ? "OpenAI" : "Embedding",
      maxBatchSize: 100,
      signal,
      prepareText: (text) => truncate(text),
      context: {
        endpoint: this.baseUrl,
        model: this.model,
        dimensions: this.dimensions
      },
      requestBatch: (batch, requestSignal, meta) => this.requestBatch(batch, requestSignal, meta)
    });
  }
};
var BedrockEmbedder = class {
  client;
  // Lazy-loaded to avoid hard dep if not using Bedrock
  model;
  dimensions;
  clientPromise;
  constructor(profile, region, model, dimensions) {
    this.model = model;
    this.dimensions = dimensions;
    this.clientPromise = (async () => {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      const { fromIni } = await import("@aws-sdk/credential-providers");
      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile })
      });
    })();
  }
  async embed(text, signal) {
    const results = await this.embedBatch([text], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal, concurrency = 10) {
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
        concurrency
      },
      requestBatch: (batch, requestSignal) => parallelMap(
        batch,
        async (text) => {
          try {
            return await this.callBedrock(client, text);
          } catch (err) {
            console.error(
              `Bedrock embedding failed (${text.slice(0, 50)}...): ${err.message}`
            );
            logError("embedder.bedrock", "item failed", {
              model: this.model,
              error: err?.message
            });
            return null;
          }
        },
        concurrency,
        requestSignal
      )
    });
  }
  async callBedrock(client, text) {
    return withRateLimitRetry(async () => {
      const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const body = JSON.stringify({
        inputText: truncate(text),
        dimensions: this.dimensions,
        normalize: true
      });
      const command = new InvokeModelCommand({
        modelId: this.model,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(body)
      });
      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      if (!responseBody.embedding) {
        throw new Error(
          "Unexpected Bedrock response: " + JSON.stringify(responseBody).slice(0, 200)
        );
      }
      return responseBody.embedding;
    }, "Bedrock embed");
  }
};
var OllamaEmbedder = class {
  url;
  model;
  constructor(url, model) {
    this.url = url.replace(/\/$/, "");
    this.model = model;
  }
  async embed(text, signal) {
    return withRateLimitRetry(async () => {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncate(text) }),
        signal
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      return json.embeddings[0];
    }, "Ollama embed");
  }
  async embedBatch(texts, signal, concurrency = 4) {
    return embedBatchWithAdaptiveFallback(texts, {
      scope: "embedder.ollama",
      providerLabel: "Ollama",
      maxBatchSize: 100,
      signal,
      prepareText: (text) => truncate(text),
      context: {
        url: this.url,
        model: this.model,
        concurrency
      },
      requestBatch: (batch, requestSignal) => parallelMap(
        batch,
        async (text) => {
          try {
            return await this.embed(text, requestSignal);
          } catch (err) {
            console.error(
              `Ollama embedding failed (${text.slice(0, 50)}...): ${err.message}`
            );
            logError("embedder.ollama", "item failed", {
              url: this.url,
              model: this.model,
              error: err?.message
            });
            return null;
          }
        },
        concurrency,
        requestSignal
      )
    });
  }
};

// src/index-store.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";

// src/chunker.ts
var HEADING_RE = /^(#{2,6})\s+(.+)$/;
function chunkMarkdown(content, maxChunkSize = 3e3, minChunkSize = 200) {
  if (!content || content.trim().length === 0) return [];
  const sections = splitByHeadings(content);
  if (sections.length === 0) return [];
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: sections[0]?.heading ?? "intro",
        startLine: 0,
        charOffset: 0
      }
    ];
  }
  let rawChunks = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue;
    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
    } else {
      const subChunks = splitByParagraphs(
        section.text,
        section.heading,
        section.startLine,
        section.charOffset,
        maxChunkSize
      );
      rawChunks.push(...subChunks);
    }
  }
  rawChunks = rawChunks.flatMap((chunk) => {
    if (chunk.text.length <= maxChunkSize) return [chunk];
    return hardSplit(chunk, maxChunkSize, 200);
  });
  rawChunks = mergeTiny(rawChunks, minChunkSize, maxChunkSize);
  return rawChunks;
}
function splitByHeadings(content) {
  const lines = content.split("\n");
  const sections = [];
  let currentHeading = "intro";
  let currentLines = [];
  let sectionStartLine = 0;
  let sectionCharOffset = 0;
  let charPos = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(HEADING_RE);
    if (match) {
      if (currentLines.length > 0) {
        sections.push({
          text: currentLines.join("\n"),
          heading: currentHeading,
          startLine: sectionStartLine,
          charOffset: sectionCharOffset
        });
      }
      currentHeading = match[2].trim();
      currentLines = [line];
      sectionStartLine = i;
      sectionCharOffset = charPos;
    } else {
      currentLines.push(line);
    }
    charPos += line.length + 1;
  }
  if (currentLines.length > 0) {
    sections.push({
      text: currentLines.join("\n"),
      heading: currentHeading,
      startLine: sectionStartLine,
      charOffset: sectionCharOffset
    });
  }
  return sections;
}
function splitByParagraphs(text, heading, startLine, charOffset, maxChunkSize) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let currentText = "";
  let currentOffset = charOffset;
  let currentStartLine = startLine;
  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length + 2 > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading,
        startLine: currentStartLine,
        charOffset: currentOffset
      });
      currentOffset = currentOffset + currentText.length + 2;
      currentStartLine += currentText.split("\n").length + 1;
      currentText = para;
    } else {
      currentText = currentText ? currentText + "\n\n" + para : para;
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      heading,
      startLine: currentStartLine,
      charOffset: currentOffset
    });
  }
  return chunks;
}
function hardSplit(chunk, maxSize, overlap) {
  const { text, heading, startLine, charOffset } = chunk;
  const chunks = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + maxSize, text.length);
    chunks.push({
      text: text.slice(pos, end),
      heading,
      startLine: startLine + text.slice(0, pos).split("\n").length - 1,
      charOffset: charOffset + pos
    });
    pos = end - (end < text.length ? overlap : 0);
    if (pos <= chunks[chunks.length - 1].charOffset - charOffset) {
      pos = end;
    }
  }
  return chunks;
}
function mergeTiny(chunks, minSize, maxSize) {
  if (chunks.length <= 1) return chunks;
  const merged = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = chunks[i];
    if (curr.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
    } else if (prev.text.length < minSize && prev.text.length + curr.text.length + 2 <= maxSize) {
      prev.text = prev.text + "\n\n" + curr.text;
      prev.heading = curr.heading;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

// src/index-store.ts
var INDEX_VERSION = 4;
var MAX_EXCERPT_LENGTH = 3500;
var KnowledgeIndex = class {
  config;
  embedder;
  data;
  dirty = false;
  saveTimer = null;
  constructor(config2, embedder2) {
    this.config = config2;
    this.embedder = embedder2;
    this.data = {
      version: INDEX_VERSION,
      dimensions: config2.dimensions,
      entries: {}
    };
  }
  size() {
    const paths = /* @__PURE__ */ new Set();
    for (const entry of Object.values(this.data.entries)) {
      paths.add(`${entry.sourceDir}/${entry.relPath}`);
    }
    return paths.size;
  }
  chunkCount() {
    return Object.keys(this.data.entries).length;
  }
  loadSync() {
    const indexFile = path3.join(this.config.indexDir, "index.json");
    if (fs3.existsSync(indexFile)) {
      try {
        const raw = fs3.readFileSync(indexFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.version === INDEX_VERSION && parsed.dimensions === this.config.dimensions) {
          this.data = parsed;
        }
      } catch {
      }
    }
  }
  async load() {
    this.loadSync();
  }
  save() {
    fs3.mkdirSync(this.config.indexDir, { recursive: true });
    const indexFile = path3.join(this.config.indexDir, "index.json");
    fs3.writeFileSync(indexFile, JSON.stringify(this.data));
    this.dirty = false;
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, 5e3);
  }
  /**
   * Build the entry key for a file chunk.
   */
  entryKey(absPath, chunkIndex) {
    return `${absPath}#${chunkIndex}`;
  }
  /**
   * Get the absolute path from an entry key (strip #chunkIndex).
   */
  absPathFromKey(key) {
    const hashIdx = key.lastIndexOf("#");
    return hashIdx >= 0 ? key.slice(0, hashIdx) : key;
  }
  indexedMtimeForFile(absPath) {
    const prefix = `${absPath}#`;
    let best = null;
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!key.startsWith(prefix)) continue;
      if (best == null || entry.mtime > best) {
        best = entry.mtime;
      }
    }
    return best;
  }
  /**
   * Remove all chunks for a given absolute file path.
   */
  removeAllChunks(absPath) {
    const prefix = absPath + "#";
    const toRemove = [];
    for (const key of Object.keys(this.data.entries)) {
      if (key.startsWith(prefix)) {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      delete this.data.entries[key];
    }
    return toRemove.length;
  }
  /**
   * Prepare embedding text for a chunk with title context.
   */
  chunkEmbedText(relPath, heading, chunkText) {
    const title = relPath.replace(/\.[^.]+$/, "").replace(/\//g, " > ");
    const sectionContext = heading && heading !== "intro" ? ` > ${heading}` : "";
    return `Title: ${title}${sectionContext}

${chunkText}`;
  }
  /**
   * Scan all configured directories, find new/changed/removed files, update index.
   */
  async sync() {
    const startedAt = Date.now();
    const allFiles = this.scanAllFiles();
    logInfo("index-store", "sync start", {
      scannedFileCount: allFiles.length,
      indexSize: this.size(),
      chunkCount: this.chunkCount()
    });
    const currentPaths = new Set(allFiles.map((f) => f.absPath));
    let removed = 0;
    const seenRemoved = /* @__PURE__ */ new Set();
    for (const key of Object.keys(this.data.entries)) {
      const absPath = this.absPathFromKey(key);
      if (!currentPaths.has(absPath) && !seenRemoved.has(absPath)) {
        seenRemoved.add(absPath);
        removed += 1;
        this.removeAllChunks(absPath);
        this.save();
      }
    }
    const toProcess = [];
    for (const file of allFiles) {
      const indexedMtime = this.indexedMtimeForFile(file.absPath);
      if (indexedMtime != null && indexedMtime >= file.mtime) continue;
      const content = this.readFileContent(file.absPath);
      if (!content || content.trim().length <= 20) continue;
      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) continue;
      toProcess.push({ ...file, content, chunks });
    }
    let added = 0;
    let updated = 0;
    if (toProcess.length > 0) {
      logInfo("index-store", "sync processing changed files", {
        fileCount: toProcess.length
      });
      const processedFiles = /* @__PURE__ */ new Set();
      const ensureFilePrepared = (fileIdx) => {
        if (processedFiles.has(fileIdx)) return;
        processedFiles.add(fileIdx);
        const file = toProcess[fileIdx];
        const hadExisting = this.removeAllChunks(file.absPath) > 0;
        if (hadExisting) updated++;
        else added++;
      };
      const allChunkTexts = [];
      const chunkMeta = [];
      let quarantinedCount = 0;
      for (let fi = 0; fi < toProcess.length; fi++) {
        const file = toProcess[fi];
        for (let ci = 0; ci < file.chunks.length; ci++) {
          const chunk = file.chunks[ci];
          const embedText = this.chunkEmbedText(file.relPath, chunk.heading, chunk.text);
          const unpairedSurrogates = countUnpairedSurrogates(embedText);
          if (this.config.quarantineEnabled && unpairedSurrogates > 0) {
            ensureFilePrepared(fi);
            const key = this.entryKey(file.absPath, ci);
            this.data.entries[key] = {
              relPath: file.relPath,
              sourceDir: file.sourceDir,
              mtime: file.mtime,
              vector: [],
              excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
              heading: chunk.heading,
              chunkIndex: ci,
              quarantined: true,
              quarantineReason: "unpaired-surrogate",
              quarantineDetails: {
                unpairedSurrogates,
                chunkChars: chunk.text.length
              }
            };
            quarantinedCount++;
            this.save();
            continue;
          }
          allChunkTexts.push(embedText);
          chunkMeta.push({ fileIdx: fi, chunkIdx: ci });
        }
      }
      if (quarantinedCount > 0) {
        logWarn("index-store", "chunks quarantined before embedding", {
          count: quarantinedCount
        });
      }
      const BATCH_SIZE = 50;
      const allVectors = new Array(allChunkTexts.length).fill(null);
      logDebug("index-store", "embedding batch plan", {
        totalChunks: allChunkTexts.length,
        batchSize: BATCH_SIZE
      });
      for (let i = 0; i < allChunkTexts.length; i += BATCH_SIZE) {
        const batchTexts = allChunkTexts.slice(i, i + BATCH_SIZE);
        const vectors = await this.embedder.embedBatch(batchTexts);
        for (let j = 0; j < vectors.length; j++) {
          allVectors[i + j] = vectors[j];
        }
      }
      const failedVectorMeta = [];
      for (let i = 0; i < allVectors.length; i++) {
        if (allVectors[i]) continue;
        const { fileIdx, chunkIdx } = chunkMeta[i];
        const file = toProcess[fileIdx];
        const chunk = file.chunks[chunkIdx];
        failedVectorMeta.push({
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          chunkIndex: chunkIdx,
          chunkChars: chunk.text.length
        });
      }
      if (failedVectorMeta.length > 0) {
        logWarn("index-store", "chunk embeddings failed", {
          failedCount: failedVectorMeta.length,
          totalChunks: allChunkTexts.length,
          sample: failedVectorMeta.slice(0, 20)
        });
      }
      for (let i = 0; i < chunkMeta.length; i++) {
        const { fileIdx, chunkIdx } = chunkMeta[i];
        const vector = allVectors[i];
        if (!vector) continue;
        const file = toProcess[fileIdx];
        ensureFilePrepared(fileIdx);
        const chunk = file.chunks[chunkIdx];
        const key = this.entryKey(file.absPath, chunkIdx);
        this.data.entries[key] = {
          relPath: file.relPath,
          sourceDir: file.sourceDir,
          mtime: file.mtime,
          vector,
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: chunkIdx,
          quarantined: false
        };
        this.save();
      }
    }
    if (added + updated + removed > 0) {
      this.save();
    }
    logInfo("index-store", "sync complete", {
      added,
      updated,
      removed,
      finalIndexSize: this.size(),
      finalChunkCount: this.chunkCount(),
      durationMs: Date.now() - startedAt
    });
    return { added, updated, removed };
  }
  async rebuild() {
    this.data.entries = {};
    await this.sync();
  }
  async search(query, limit, signal) {
    const queryVector = await this.embedder.embed(query, signal);
    const scored = [];
    for (const [key, entry] of Object.entries(this.data.entries)) {
      if (!entry.vector || entry.vector.length === 0 || entry.quarantined) continue;
      const score = dotProduct(queryVector, entry.vector);
      scored.push({ key, absPath: this.absPathFromKey(key), score });
    }
    scored.sort((a, b) => b.score - a.score);
    const seenPaths = /* @__PURE__ */ new Set();
    const deduped = [];
    for (const item of scored) {
      if (seenPaths.has(item.absPath)) continue;
      seenPaths.add(item.absPath);
      deduped.push(item);
      if (deduped.length >= limit) break;
    }
    return deduped.filter((s) => s.score > 0.15).map((s) => {
      const entry = this.data.entries[s.key];
      return {
        path: s.absPath,
        score: s.score,
        excerpt: entry.excerpt,
        heading: entry.heading
      };
    });
  }
  /**
   * Update a single file in the index (called by watcher).
   */
  async updateFile(absPath, sourceDir) {
    if (!fs3.existsSync(absPath)) {
      this.removeFile(absPath);
      return;
    }
    const relPath = path3.relative(sourceDir, absPath);
    if (this.shouldSkip(relPath, path3.basename(absPath))) return;
    const stat = fs3.statSync(absPath);
    const content = this.readFileContent(absPath);
    if (!content || content.trim().length <= 20) {
      this.removeFile(absPath);
      return;
    }
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.removeFile(absPath);
      return;
    }
    this.removeAllChunks(absPath);
    const texts = [];
    const map = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const text = this.chunkEmbedText(relPath, chunk.heading, chunk.text);
      const unpairedSurrogates = countUnpairedSurrogates(text);
      if (this.config.quarantineEnabled && unpairedSurrogates > 0) {
        const key = this.entryKey(absPath, i);
        this.data.entries[key] = {
          relPath,
          sourceDir,
          mtime: stat.mtimeMs,
          vector: [],
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: i,
          quarantined: true,
          quarantineReason: "unpaired-surrogate",
          quarantineDetails: {
            unpairedSurrogates,
            chunkChars: chunk.text.length
          }
        };
        this.save();
        continue;
      }
      texts.push(text);
      map.push(i);
    }
    const vectors = texts.length > 0 ? await this.embedder.embedBatch(texts) : [];
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      const chunkIndex = map[i];
      const key = this.entryKey(absPath, chunkIndex);
      this.data.entries[key] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt: chunks[chunkIndex].text.slice(0, MAX_EXCERPT_LENGTH),
        heading: chunks[chunkIndex].heading,
        chunkIndex,
        quarantined: false
      };
      this.save();
    }
  }
  removeFile(absPath) {
    const removed = this.removeAllChunks(absPath);
    if (removed > 0) {
      this.save();
    }
  }
  /** Alias for removeFile — removes all data for a file path. */
  deleteFile(absPath) {
    this.removeFile(absPath);
  }
  /** Flush pending saves and release resources. */
  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.save();
    }
  }
  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------
  scanAllFiles() {
    const results = [];
    for (const dir of this.config.dirs) {
      this.walkDir(dir, dir, results);
    }
    return results;
  }
  walkDir(currentDir, sourceDir, results) {
    let entries;
    try {
      entries = fs3.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path3.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (this.config.excludeDirs.includes(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        this.walkDir(absPath, sourceDir, results);
      } else if (entry.isFile()) {
        const ext = path3.extname(entry.name);
        if (!this.config.fileExtensions.includes(ext)) continue;
        const relPath = path3.relative(sourceDir, absPath);
        if (this.shouldSkip(relPath, entry.name)) continue;
        try {
          const stat = fs3.statSync(absPath);
          results.push({ absPath, relPath, sourceDir, mtime: stat.mtimeMs });
        } catch {
        }
      }
    }
  }
  shouldSkip(relPath, _basename) {
    const parts = relPath.split(path3.sep);
    for (const part of parts) {
      if (this.config.excludeDirs.includes(part) || part.startsWith(".")) {
        return true;
      }
    }
    return false;
  }
  readFileContent(absPath) {
    try {
      const content = fs3.readFileSync(absPath, "utf-8");
      return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    } catch {
      return null;
    }
  }
};
function dotProduct(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// src/sync-worker.ts
process.on("uncaughtException", (err) => {
  logError("sync-worker", "uncaught exception", {
    message: err.message,
    stack: err.stack
  });
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}
`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logError("sync-worker", "unhandled rejection", {
    reason: String(reason)
  });
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}
`);
  process.exit(1);
});
logInfo("sync-worker", "startup", {
  pid: process.pid,
  configPath: process.env.KNOWLEDGE_SEARCH_CONFIG,
  logPath: getKnowledgeSearchLogPath()
});
var config = loadConfig();
if (!config) {
  logInfo("sync-worker", "no config loaded; exiting without sync");
  process.exit(0);
}
logInfo("sync-worker", "config loaded", {
  hasProvider: Boolean(config.provider),
  providerType: config.provider?.type,
  dimensions: config.dimensions,
  dirCount: config.dirs.length,
  kbCount: config.knowledgeBases.length
});
var embedder = createEmbedder(config.provider, config.dimensions);
var index = new KnowledgeIndex(config, embedder);
index.loadSync();
var syncStartedAt = Date.now();
index.sync().then(({ added, updated, removed }) => {
  const result = JSON.stringify({ added, updated, removed, size: index.size(), chunks: index.chunkCount() });
  logInfo("sync-worker", "sync completed", {
    added,
    updated,
    removed,
    size: index.size(),
    chunks: index.chunkCount(),
    durationMs: Date.now() - syncStartedAt,
    resultLength: result.length
  });
  process.stdout.write(result);
  process.exit(0);
}).catch((err) => {
  logError("sync-worker", "sync failed", {
    message: err.message,
    stack: err.stack,
    durationMs: Date.now() - syncStartedAt
  });
  process.stderr.write(err.message);
  process.exit(1);
});
