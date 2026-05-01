#!/usr/bin/env node

// src/config.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var CONFIG_DIR_NAME = ".pi";
var CONFIG_FILENAME = "knowledge-search.json";
var SETTINGS_FILENAME = "settings.json";
var resolvedConfigContext = null;
function loadConfig() {
  const { configPath, configDir } = getConfigContext();
  resolvedConfigContext = { configPath, configDir };
  let file = null;
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
    }
  }
  const envDirs = process.env.KNOWLEDGE_SEARCH_DIRS;
  const envAdapterSourceUri = envStr("KB_ADAPTER_SOURCE_URI") ?? envStr("KNOWLEDGE_SEARCH_KB_ADAPTER_SOURCE_URI");
  const hasKBs = (file?.knowledgeBases?.length ?? 0) > 0;
  const hasAdapterSource = Boolean(envAdapterSourceUri ?? file?.kbAdapterSourceUri);
  if (!file && !envDirs) {
    return null;
  }
  const home = process.env.HOME || "/tmp";
  const envBaseDir = process.cwd();
  const resolveConfigPath = (value) => resolveLocalPath(value, configDir, home);
  const resolveEnvPath = (value) => resolveLocalPath(value, envBaseDir, home);
  const dirs = (envDirs ? envDirs.split(",").map((d) => d.trim()) : file?.dirs ?? []).filter(Boolean).map(envDirs ? resolveEnvPath : resolveConfigPath).filter(Boolean);
  if (dirs.length === 0 && !hasKBs && !hasAdapterSource) return null;
  const fileExtensions = envStr("KNOWLEDGE_SEARCH_EXTENSIONS")?.split(",").map((e) => e.trim()) ?? file?.fileExtensions ?? [".md", ".txt"];
  const excludeDirs = envStr("KNOWLEDGE_SEARCH_EXCLUDE")?.split(",").map((d) => d.trim()) ?? file?.excludeDirs ?? ["node_modules", ".git", ".obsidian", ".trash"];
  const dimensions = envInt("KNOWLEDGE_SEARCH_DIMENSIONS") ?? file?.dimensions ?? 512;
  const kbAdapter = normalizeKbAdapter(
    kbAdapterInput(envStr("KB_ADAPTER") ?? envStr("KNOWLEDGE_SEARCH_KB_ADAPTER") ?? file?.kbAdapter)
  );
  const envIndexDir = envStr("KNOWLEDGE_SEARCH_INDEX_DIR");
  const defaultIndexDir = envIndexDir ? resolveEnvPath(envIndexDir) : path.join(configDir, "knowledge-search");
  const kbAdapterSourceUri = normalizeKbAdapterSourceUri(
    envAdapterSourceUri ?? file?.kbAdapterSourceUri,
    kbAdapter,
    defaultIndexDir,
    home,
    envAdapterSourceUri ? envBaseDir : configDir
  );
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
            "OpenAI-compatible requires baseUrl. Set KNOWLEDGE_SEARCH_COMPAT_BASE_URL or provide it in your knowledge-search.json config."
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
  const indexDir = adapterDirectoryFromSourceUri(kbAdapterSourceUri);
  return {
    dirs,
    fileExtensions,
    excludeDirs,
    dimensions,
    provider,
    indexDir,
    kbAdapter,
    kbAdapterSourceUri,
    knowledgeBases: normalizeKnowledgeBases(file?.knowledgeBases ?? [])
  };
}
function getConfigContext() {
  const home = process.env.HOME || "/tmp";
  const configuredPath = envStr("KNOWLEDGE_SEARCH_CONFIG");
  if (configuredPath) {
    const configPath2 = resolveLocalPath(configuredPath, process.cwd(), home);
    return { configPath: configPath2, configDir: path.dirname(configPath2) };
  }
  const projectPiDir = findProjectPiDir();
  if (projectPiDir) {
    return {
      configPath: path.join(projectPiDir, CONFIG_FILENAME),
      configDir: projectPiDir
    };
  }
  const configPath = path.join(home, CONFIG_DIR_NAME, CONFIG_FILENAME);
  return { configPath, configDir: path.dirname(configPath) };
}
function envStr(key) {
  const v = process.env[key]?.trim();
  return v || void 0;
}
function envInt(key) {
  const v = envStr(key);
  return v ? parseInt(v, 10) : void 0;
}
function normalizeKnowledgeBases(values) {
  return values.map((value) => normalizeKnowledgeBase(value));
}
function normalizeKnowledgeBase(value) {
  const id = value.id?.trim();
  if (!id) {
    throw new Error("Knowledge base id is required.");
  }
  const syncMode = value.syncMode ?? "search";
  if (syncMode !== "search" && !value.dataSourceId) {
    throw new Error(
      `Knowledge base ${id} sets syncMode="${syncMode}" but is missing dataSourceId.`
    );
  }
  if (syncMode !== "search" && !value.dataSourceType) {
    throw new Error(
      `Knowledge base ${id} sets syncMode="${syncMode}" but is missing dataSourceType.`
    );
  }
  return {
    id,
    profile: value.profile?.trim() || "default",
    region: value.region?.trim() || "us-east-1",
    ...value.label?.trim() ? { label: value.label.trim() } : {},
    ...value.dataSourceId?.trim() ? { dataSourceId: value.dataSourceId.trim() } : {},
    ...value.dataSourceType ? { dataSourceType: value.dataSourceType } : {},
    syncMode,
    ingestBatchSize: normalizeIngestBatchSize(value.ingestBatchSize),
    pollIntervalMs: normalizePositiveInt(value.pollIntervalMs, 2e3),
    maxWaitMs: normalizePositiveInt(value.maxWaitMs, 3e5)
  };
}
function normalizeIngestBatchSize(value) {
  const normalized = normalizePositiveInt(value, 25);
  return Math.min(normalized, 25);
}
function normalizePositiveInt(value, fallback) {
  if (!Number.isFinite(value) || value == null) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}
function normalizeKbAdapter(value) {
  switch (value) {
    case "json_v2":
      return "json_v2";
    case "jsonl_v3":
    case "json_v3":
      return "json_v3";
    case "sqlite_local":
      return "sqlite_local";
    case "jsonl_v4":
    default:
      return "jsonl_v4";
  }
}
function kbAdapterInput(value) {
  switch (value) {
    case "json_v2":
    case "json_v3":
    case "jsonl_v3":
    case "jsonl_v4":
    case "sqlite_local":
      return value;
    default:
      return void 0;
  }
}
function kbAdapterFilename(adapter) {
  switch (adapter) {
    case "json_v2":
    case "json_v3":
      return "index.json";
    case "sqlite_local":
      return "index.sqlite";
    case "jsonl_v4":
    default:
      return "index.jsonl";
  }
}
function normalizeKbAdapterSourceUri(value, adapter, defaultIndexDir, home, baseDir) {
  const fallbackPath = path.join(defaultIndexDir, kbAdapterFilename(adapter));
  const localPath = value ? resolveLocalPath(value, baseDir, home) : fallbackPath;
  return pathToFileURL(localPath).toString();
}
function adapterDirectoryFromSourceUri(uri) {
  if (!uri.startsWith("file:")) {
    throw new Error(`Local adapter source URI must use the file: scheme. Received: ${uri}`);
  }
  return path.dirname(fileURLToPath(uri));
}
function resolveLocalPath(value, baseDir, home) {
  if (value.startsWith("file:")) {
    return fileURLToPath(value);
  }
  const expanded = expandHomePath(value, home);
  if (path.isAbsolute(expanded) || isWindowsAbsolutePath(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(baseDir, expanded);
}
function findProjectPiDir(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  let nearestPiSettingsDir = null;
  while (true) {
    const piDir = path.join(current, CONFIG_DIR_NAME);
    if (fs.existsSync(path.join(piDir, CONFIG_FILENAME))) {
      return piDir;
    }
    if (!nearestPiSettingsDir && fs.existsSync(path.join(piDir, SETTINGS_FILENAME))) {
      nearestPiSettingsDir = piDir;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return nearestPiSettingsDir;
    }
    current = parent;
  }
}
function expandHomePath(value, home) {
  if (!value.startsWith("~")) {
    return value;
  }
  return path.join(home, value.slice(1).replace(/^[/\\]+/, ""));
}
function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[/\\]/.test(value);
}

// src/embedder.ts
function createEmbedder(config2, dimensions) {
  switch (config2.type) {
    case "openai":
      return new OpenAIEmbedder(config2.apiKey, config2.model, dimensions, void 0);
    case "openai-compatible":
      return new OpenAIEmbedder(config2.apiKey ?? "", config2.model, dimensions, config2.baseUrl);
    case "bedrock":
      return new BedrockEmbedder(config2.profile, config2.region, config2.model, dimensions);
    case "ollama":
      return new OllamaEmbedder(config2.url, config2.model);
  }
}
function truncate(text2, maxChars = 1e4) {
  return text2.length > maxChars ? text2.slice(0, maxChars) : text2;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
async function createBedrockRuntimeClient(profile, region) {
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  return new BedrockRuntimeClient(await bedrockClientOptions(profile, region));
}
async function bedrockClientOptions(profile, region) {
  const normalizedProfile = profile.trim();
  if (normalizedProfile.length === 0 || normalizedProfile === "default") {
    return { region };
  }
  const { fromIni } = await import("@aws-sdk/credential-providers");
  return {
    region,
    credentials: fromIni({ profile: normalizedProfile })
  };
}
var OpenAIEmbedder = class {
  apiKey;
  model;
  dimensions;
  endpoint;
  constructor(apiKey, model, dimensions, baseUrl) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    if (baseUrl) {
      this.endpoint = `${baseUrl.replace(/\/$/, "")}/v1/embeddings`;
    } else {
      this.endpoint = `https://api.openai.com/v1/embeddings`;
    }
  }
  async embed(text2, signal) {
    const results = await this.embedBatch([text2], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal) {
    const BATCH = 100;
    const results = new Array(texts.length);
    for (let i = 0; i < texts.length; i += BATCH) {
      if (signal?.aborted) throw new Error("Aborted");
      const batch = texts.slice(i, i + BATCH).map((t) => truncate(t));
      try {
        const json = await withRateLimitRetry(async () => {
          const res = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              ...this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              input: batch,
              model: this.model,
              dimensions: this.dimensions
            }),
            signal
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 200)}`);
          }
          return await res.json();
        }, "embedding");
        for (const item of json.data) {
          results[i + item.index] = item.embedding;
        }
      } catch (err) {
        for (let j = 0; j < batch.length; j++) {
          results[i + j] = null;
        }
        const label = this.endpoint.includes("api.openai.com") ? "OpenAI" : `Embedding (${this.endpoint})`;
        console.error(`${label} batch embedding failed: ${err.message}`);
      }
    }
    return results;
  }
};
var BedrockEmbedder = class {
  model;
  dimensions;
  clientPromise;
  constructor(profile, region, model, dimensions) {
    this.model = model;
    this.dimensions = dimensions;
    this.clientPromise = createBedrockRuntimeClient(profile, region);
  }
  async embed(text2, signal) {
    const results = await this.embedBatch([text2], signal);
    if (!results[0]) throw new Error("Embedding failed \u2014 provider returned no vector");
    return results[0];
  }
  async embedBatch(texts, signal, concurrency = 10) {
    const client = await this.clientPromise;
    return parallelMap(
      texts,
      async (text2) => {
        try {
          return await this.callBedrock(client, text2);
        } catch (err) {
          console.error(`Bedrock embedding failed (${text2.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }
  async callBedrock(client, text2) {
    return withRateLimitRetry(async () => {
      const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const body = JSON.stringify({
        inputText: truncate(text2),
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
  async embed(text2, signal) {
    return withRateLimitRetry(async () => {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: truncate(text2) }),
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
    return parallelMap(
      texts,
      async (text2) => {
        try {
          return await this.embed(text2, signal);
        } catch (err) {
          console.error(`Ollama embedding failed (${text2.slice(0, 50)}...): ${err.message}`);
          return null;
        }
      },
      concurrency,
      signal
    );
  }
};

// src/adapters/base.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/chunker.ts
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";
var markdownProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml", "toml"]);
var LARGE_FILE_FAST_PATH_CHARS = 12e4;
function chunkMarkdown(content, maxChunkSize = 3e3, minChunkSize = 200) {
  if (!content || content.trim().length === 0) return [];
  if (content.length >= LARGE_FILE_FAST_PATH_CHARS) {
    return chunkMarkdownFast(content, maxChunkSize, minChunkSize);
  }
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
      rawChunks.push(...splitByBlocks(section, maxChunkSize));
    }
  }
  rawChunks = rawChunks.flatMap(
    (chunk) => chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );
  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}
function chunkMarkdownFast(content, maxChunkSize, minChunkSize) {
  if (content.length <= maxChunkSize) {
    return [
      {
        text: content.trim(),
        heading: "intro",
        startLine: 0,
        charOffset: 0
      }
    ];
  }
  const starts = lineStartOffsets(content);
  const headingRegex = /^##+\s+(.+)$/gm;
  const headingMatches = [];
  for (const match of content.matchAll(headingRegex)) {
    const start = match.index ?? 0;
    headingMatches.push({
      start,
      startLine: lineFromOffset(start, starts),
      heading: (match[1] ?? "intro").trim() || "intro"
    });
  }
  const sections = [];
  if (headingMatches.length === 0) {
    sections.push({ text: content, heading: "intro", startLine: 0, charOffset: 0 });
  } else {
    if (headingMatches[0].start > 0) {
      sections.push({
        text: content.slice(0, headingMatches[0].start),
        heading: "intro",
        startLine: 0,
        charOffset: 0
      });
    }
    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].start;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].start : content.length;
      sections.push({
        text: content.slice(start, end),
        heading: headingMatches[i].heading,
        startLine: headingMatches[i].startLine,
        charOffset: start
      });
    }
  }
  let rawChunks = [];
  for (const section of sections) {
    if (section.text.trim().length === 0) continue;
    if (section.text.length <= maxChunkSize) {
      rawChunks.push(section);
      continue;
    }
    rawChunks.push(...splitByParagraphsFallback(section, maxChunkSize));
  }
  rawChunks = rawChunks.flatMap(
    (chunk) => chunk.text.length <= maxChunkSize ? [chunk] : hardSplit(chunk, maxChunkSize, 200)
  );
  return mergeTiny(rawChunks, minChunkSize, maxChunkSize);
}
function lineStartOffsets(text2) {
  const starts = [0];
  for (let i = 0; i < text2.length; i++) {
    if (text2.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}
function offsetFromLine(line, starts) {
  if (!line || line <= 1) return 0;
  return starts[Math.min(line - 1, starts.length - 1)] ?? 0;
}
function lineFromOffset(offset, starts) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = low + high >> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, low - 1);
}
function headingText(node) {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map((child) => headingText(child)).join("");
}
function splitByHeadings(content) {
  const tree = markdownProcessor.parse(content);
  const starts = lineStartOffsets(content);
  const headings = (tree.children ?? []).filter((node) => node.type === "heading" && node.depth >= 2).map((node) => {
    const line = node.position?.start?.line;
    const start = offsetFromLine(line, starts);
    return {
      start,
      startLine: lineFromOffset(start, starts),
      heading: headingText(node).trim() || "intro"
    };
  }).sort((a, b) => a.start - b.start);
  if (headings.length === 0) {
    return [{ text: content, heading: "intro", startLine: 0, charOffset: 0 }];
  }
  const sections = [];
  if (headings[0].start > 0) {
    sections.push({
      text: content.slice(0, headings[0].start),
      heading: "intro",
      startLine: 0,
      charOffset: 0
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].start;
    const end = i + 1 < headings.length ? headings[i + 1].start : content.length;
    sections.push({
      text: content.slice(start, end),
      heading: headings[i].heading,
      startLine: headings[i].startLine,
      charOffset: start
    });
  }
  return sections;
}
function splitByBlocks(section, maxChunkSize) {
  const text2 = section.text;
  const tree = markdownProcessor.parse(text2);
  const starts = lineStartOffsets(text2);
  const blocks = (tree.children ?? []).map((node) => {
    const startLine = node.position?.start?.line;
    const endLine = node.position?.end?.line;
    if (!startLine || !endLine) return null;
    return {
      start: offsetFromLine(startLine, starts),
      end: offsetFromLine(endLine + 1, starts)
    };
  }).filter((x) => Boolean(x)).sort((a, b) => a.start - b.start);
  if (blocks.length === 0) {
    return splitByParagraphsFallback(section, maxChunkSize);
  }
  const units = blocks.map((block, i) => ({
    start: i === 0 ? 0 : block.start,
    end: i + 1 < blocks.length ? blocks[i + 1].start : text2.length
  }));
  const chunks = [];
  let currentText = "";
  let currentOffset = section.charOffset;
  let currentStartLine = section.startLine;
  for (const unit of units) {
    const unitText = text2.slice(unit.start, unit.end);
    if (currentText.length > 0 && currentText.length + unitText.length > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading: section.heading,
        startLine: currentStartLine,
        charOffset: currentOffset
      });
      currentText = unitText;
      currentOffset = section.charOffset + unit.start;
      currentStartLine = section.startLine + lineFromOffset(unit.start, starts);
    } else {
      currentText += unitText;
    }
  }
  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      heading: section.heading,
      startLine: currentStartLine,
      charOffset: currentOffset
    });
  }
  return chunks;
}
function splitByParagraphsFallback(section, maxChunkSize) {
  const paragraphs = section.text.split(/\n\n+/);
  const chunks = [];
  let currentText = "";
  let currentOffset = section.charOffset;
  let currentStartLine = section.startLine;
  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length + 2 > maxChunkSize) {
      chunks.push({
        text: currentText.trim(),
        heading: section.heading,
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
      heading: section.heading,
      startLine: currentStartLine,
      charOffset: currentOffset
    });
  }
  return chunks;
}
function hardSplit(chunk, maxSize, overlap) {
  const { text: text2, heading, startLine, charOffset } = chunk;
  const chunks = [];
  let pos = 0;
  while (pos < text2.length) {
    const end = Math.min(pos + maxSize, text2.length);
    chunks.push({
      text: text2.slice(pos, end),
      heading,
      startLine: startLine + text2.slice(0, pos).split("\n").length - 1,
      charOffset: charOffset + pos
    });
    pos = end - (end < text2.length ? overlap : 0);
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

// src/adapters/base.ts
var JSON_V2_VERSION = 2;
var JSON_V3_VERSION = 3;
var INDEX_VERSION = 4;
var LEGACY_JSON_VERSION = JSON_V3_VERSION;
var JSON_STREAM_CHUNK_BYTES = 256 * 1024;
var SEARCH_SCORE_THRESHOLD = 0.15;
var MAX_EXCERPT_LENGTH = 3500;
var EMBED_BATCH_SIZE = 50;
var registry = /* @__PURE__ */ new Map();
function createEmptyIndexData(dimensions, version = INDEX_VERSION) {
  return {
    version,
    dimensions,
    reindexState: "running",
    entries: {}
  };
}
function registerIndexAdapter(kind, adapter) {
  registry.set(kind, adapter);
}
function createIndexAdapter(source, dimensions, adapter) {
  const Adapter = registry.get(adapter);
  if (!Adapter) {
    throw new Error(`Unknown index adapter: ${adapter}`);
  }
  return new Adapter(source, dimensions);
}
function dotProduct(a, b) {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}
var SearchAdapterBase = class {
};
var AdapterBase = class extends SearchAdapterBase {
  /**
   * Build a format-specific adapter around a configured source path.
   *
   * `source` may be the original configured path/URI or a descriptor inherited
   * from another adapter in a migration chain. The descriptor form is what lets
   * fallback adapters stay wired to the same logical index while swapping file
   * extensions under the hood.
   */
  constructor(source, dimensions, file, adapter, revision) {
    super();
    this.dimensions = dimensions;
    this.file = file;
    this.adapter = adapter;
    this.revision = revision;
    this.sourceDescriptor = resolveAdapterSource(source, adapter, file);
  }
  dimensions;
  file;
  adapter;
  revision;
  client;
  sourceDescriptor;
  kind() {
    return this.adapter;
  }
  version() {
    return this.revision;
  }
  /* Preserve the selected path for the active format and derive sibling paths for fallbacks. */
  path() {
    if (this.sourceDescriptor.selectedKind === this.adapter) {
      return this.sourceDescriptor.selectedPath;
    }
    return siblingPath(this.sourceDescriptor.selectedPath, path2.extname(this.file));
  }
  exists() {
    return fs2.existsSync(this.path());
  }
  empty() {
    return this.blank();
  }
  async open() {
    return this.client;
  }
  async close() {
  }
  accepts(adapter) {
    return adapter.kind() === this.kind() && adapter.version() === this.version();
  }
  async migrate(adapter, data) {
    if (this.accepts(adapter)) {
      return data;
    }
    throw new Error(
      `${this.kind()}@${this.version()} cannot migrate from ${adapter.kind()}@${adapter.version()}`
    );
  }
  async create(data) {
    await this.write(data);
  }
  async update(data) {
    await this.write(data);
  }
  async delete() {
    try {
      await fs2.promises.rm(this.path(), { force: true });
    } catch {
    }
  }
  reindex(stateOrContext, context) {
    if (!context) {
      return this.state(stateOrContext.data.reindexState);
    }
    const nextState = stateOrContext;
    if (context.data.reindexState === nextState) return;
    context.data.reindexState = nextState;
    context.scheduleSave();
  }
  async search(query, limit, context, signal) {
    const queryVector = await context.embedder.embed(query, signal);
    const scored = [];
    for (const [key, entry] of Object.entries(context.data.entries)) {
      const score = dotProduct(queryVector, entry.vector);
      scored.push({ key, absPath: this.absPathFromKey(key), score });
    }
    scored.sort((left, right) => right.score - left.score);
    const seenPaths = /* @__PURE__ */ new Set();
    const deduped = [];
    for (const item of scored) {
      if (item.score <= SEARCH_SCORE_THRESHOLD || seenPaths.has(item.absPath)) {
        continue;
      }
      seenPaths.add(item.absPath);
      deduped.push(item);
      if (deduped.length >= limit) {
        break;
      }
    }
    return deduped.map((item) => {
      const entry = context.data.entries[item.key];
      return {
        path: item.absPath,
        score: item.score,
        excerpt: entry.excerpt,
        heading: entry.heading
      };
    });
  }
  async sync(context, onProgress) {
    const allFiles = this.scanAllFiles(context);
    const currentPaths = new Set(allFiles.map((file) => file.absPath));
    let removed = 0;
    const seenRemoved = /* @__PURE__ */ new Set();
    for (const key of Object.keys(context.data.entries)) {
      const absPath = this.absPathFromKey(key);
      if (!currentPaths.has(absPath) && !seenRemoved.has(absPath)) {
        seenRemoved.add(absPath);
        removed += 1;
        this.removeAllChunks(absPath, context.data);
      }
    }
    this.emitProgress(onProgress, {
      phase: "scan",
      processed: allFiles.length,
      total: allFiles.length,
      added: 0,
      updated: 0,
      removed
    });
    const toProcess = [];
    for (const file of allFiles) {
      const existing = context.data.entries[this.entryKey(file.absPath, 0)];
      if (existing && existing.mtime >= file.mtime) {
        continue;
      }
      const content = this.readFileContent(file.absPath);
      if (!content || content.trim().length <= 20) {
        continue;
      }
      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) {
        continue;
      }
      toProcess.push({ file, chunks });
    }
    this.emitProgress(onProgress, {
      phase: "queue",
      processed: toProcess.length,
      total: toProcess.length,
      added: 0,
      updated: 0,
      removed
    });
    let added = 0;
    let updated = 0;
    if (toProcess.length > 0) {
      const allChunkTexts = [];
      const chunkMeta = [];
      for (let fileIdx = 0; fileIdx < toProcess.length; fileIdx += 1) {
        const current = toProcess[fileIdx];
        for (let chunkIdx = 0; chunkIdx < current.chunks.length; chunkIdx += 1) {
          const chunk = current.chunks[chunkIdx];
          allChunkTexts.push(this.chunkEmbedText(current.file.relPath, chunk.heading, chunk.text));
          chunkMeta.push({ fileIdx, chunkIdx });
        }
      }
      const allVectors = new Array(allChunkTexts.length).fill(null);
      for (let index2 = 0; index2 < allChunkTexts.length; index2 += EMBED_BATCH_SIZE) {
        const batchTexts = allChunkTexts.slice(index2, index2 + EMBED_BATCH_SIZE);
        const vectors = await context.embedder.embedBatch(batchTexts);
        for (let offset = 0; offset < vectors.length; offset += 1) {
          allVectors[index2 + offset] = vectors[offset] ?? null;
        }
        this.emitProgress(onProgress, {
          phase: "embed",
          processed: Math.min(index2 + vectors.length, allChunkTexts.length),
          total: allChunkTexts.length,
          added,
          updated,
          removed
        });
      }
      const processedFiles = /* @__PURE__ */ new Set();
      for (let index2 = 0; index2 < chunkMeta.length; index2 += 1) {
        const { fileIdx, chunkIdx } = chunkMeta[index2];
        const vector = allVectors[index2];
        if (!vector) {
          continue;
        }
        const current = toProcess[fileIdx];
        if (!processedFiles.has(fileIdx)) {
          processedFiles.add(fileIdx);
          const hadExisting = this.removeAllChunks(current.file.absPath, context.data) > 0;
          if (hadExisting) updated += 1;
          else added += 1;
        }
        const chunk = current.chunks[chunkIdx];
        context.data.entries[this.entryKey(current.file.absPath, chunkIdx)] = {
          relPath: current.file.relPath,
          sourceDir: current.file.sourceDir,
          mtime: current.file.mtime,
          vector,
          excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
          heading: chunk.heading,
          chunkIndex: chunkIdx
        };
        this.emitProgress(onProgress, {
          phase: "upsert",
          processed: index2 + 1,
          total: chunkMeta.length,
          added,
          updated,
          removed
        });
      }
    }
    return { added, updated, removed };
  }
  async reset(context, onProgress) {
    this.emitProgress(onProgress, {
      phase: "init",
      processed: 0,
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
      detail: "resetting index state"
    });
    context.data.entries = {};
    context.scheduleSave();
  }
  async ingest(absPath, sourceDir, context) {
    if (!fs2.existsSync(absPath)) {
      this.remove(absPath, context);
      return;
    }
    const relPath = path2.relative(sourceDir, absPath);
    if (this.shouldSkip(relPath, context.config)) {
      return;
    }
    const stat = fs2.statSync(absPath);
    const content = this.readFileContent(absPath);
    if (!content || content.trim().length <= 20) {
      this.remove(absPath, context);
      return;
    }
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      this.remove(absPath, context);
      return;
    }
    this.removeAllChunks(absPath, context.data);
    const texts = chunks.map((chunk) => this.chunkEmbedText(relPath, chunk.heading, chunk.text));
    const vectors = await context.embedder.embedBatch(texts);
    for (let index2 = 0; index2 < chunks.length; index2 += 1) {
      const vector = vectors[index2];
      if (!vector) {
        continue;
      }
      const chunk = chunks[index2];
      context.data.entries[this.entryKey(absPath, index2)] = {
        relPath,
        sourceDir,
        mtime: stat.mtimeMs,
        vector,
        excerpt: chunk.text.slice(0, MAX_EXCERPT_LENGTH),
        heading: chunk.heading,
        chunkIndex: index2
      };
    }
    context.scheduleSave();
  }
  remove(absPath, context) {
    if (this.removeAllChunks(absPath, context.data) > 0) {
      context.scheduleSave();
    }
  }
  state(value) {
    return value === "paused" ? "paused" : "running";
  }
  data(entries, state, version = this.version()) {
    return {
      version,
      dimensions: this.dimensions,
      reindexState: this.state(state),
      entries
    };
  }
  blank() {
    return createEmptyIndexData(this.dimensions, this.version());
  }
  migrated(data, version = this.version()) {
    return {
      ...data,
      version,
      dimensions: this.dimensions,
      reindexState: this.state(data.reindexState),
      entries: { ...data.entries }
    };
  }
  bind(client) {
    this.client = client;
    return client;
  }
  ensure() {
    fs2.mkdirSync(path2.dirname(this.path()), { recursive: true });
  }
  async atomic(run) {
    this.ensure();
    const final = this.path();
    const tmp = `${final}.tmp`;
    try {
      await run(tmp);
      await fs2.promises.rename(tmp, final);
    } catch (error) {
      try {
        await fs2.promises.rm(tmp, { force: true });
      } catch {
      }
      throw error;
    }
  }
  /* Validate that a hydrated entry conforms to the normalized v3/v4 shape. */
  valid(value) {
    if (!value || typeof value !== "object") return false;
    const entry = value;
    return typeof entry.relPath === "string" && typeof entry.sourceDir === "string" && typeof entry.mtime === "number" && Array.isArray(entry.vector) && typeof entry.excerpt === "string" && typeof entry.heading === "string" && typeof entry.chunkIndex === "number";
  }
  emitProgress(onProgress, progress) {
    if (!onProgress) return;
    try {
      onProgress(progress);
    } catch {
    }
  }
  entryKey(absPath, chunkIndex) {
    return `${absPath}#${chunkIndex}`;
  }
  absPathFromKey(key) {
    const hashIdx = key.lastIndexOf("#");
    return hashIdx >= 0 ? key.slice(0, hashIdx) : key;
  }
  removeAllChunks(absPath, data) {
    const prefix = `${absPath}#`;
    const toRemove = Object.keys(data.entries).filter((key) => key.startsWith(prefix));
    for (const key of toRemove) {
      delete data.entries[key];
    }
    return toRemove.length;
  }
  chunkEmbedText(relPath, heading, chunkText) {
    const title = relPath.replace(/\.[^.]+$/, "").replace(/\//g, " > ");
    const sectionContext = heading && heading !== "intro" ? ` > ${heading}` : "";
    return `Title: ${title}${sectionContext}

${chunkText}`;
  }
  scanAllFiles(context) {
    const results = [];
    for (const dir of context.config.dirs) {
      this.walkDir(dir, dir, results, context.config);
    }
    return results;
  }
  walkDir(currentDir, sourceDir, results, config2) {
    let entries;
    try {
      entries = fs2.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absPath = path2.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (config2.excludeDirs.includes(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        this.walkDir(absPath, sourceDir, results, config2);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!config2.fileExtensions.includes(path2.extname(entry.name))) {
        continue;
      }
      const relPath = path2.relative(sourceDir, absPath);
      if (this.shouldSkip(relPath, config2)) {
        continue;
      }
      try {
        const stat = fs2.statSync(absPath);
        results.push({ absPath, relPath, sourceDir, mtime: stat.mtimeMs });
      } catch {
      }
    }
  }
  shouldSkip(relPath, config2) {
    const parts = relPath.split(path2.sep);
    for (const part of parts) {
      if (config2.excludeDirs.includes(part) || part.startsWith(".")) {
        return true;
      }
    }
    return false;
  }
  readFileContent(absPath) {
    try {
      const content = fs2.readFileSync(absPath, "utf-8");
      return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
    } catch {
      return null;
    }
  }
};
function resolveAdapterSource(input, adapter, file) {
  if (typeof input !== "string") {
    return input;
  }
  const localPath = resolveLocalPath2(input);
  if (looksLikeFilePath(localPath)) {
    return {
      selectedKind: adapter,
      selectedPath: path2.resolve(localPath)
    };
  }
  return {
    selectedKind: adapter,
    selectedPath: path2.join(path2.resolve(localPath), file)
  };
}
function resolveLocalPath2(value) {
  return value.startsWith("file:") ? fileURLToPath2(value) : value;
}
function looksLikeFilePath(value) {
  return path2.extname(value) !== "";
}
function siblingPath(selectedPath, extension) {
  const parsed = path2.parse(selectedPath);
  if (!parsed.ext) {
    return `${selectedPath}${extension}`;
  }
  return path2.join(parsed.dir, `${parsed.name}${extension}`);
}
var ChainAdapter = class {
  /**
   * Compose the canonical target adapter with any readable fallback adapters.
   *
   * The target defines the public surface presented to callers; fallbacks only
   * exist to read legacy files and migrate them forward.
   */
  constructor(target, fallbacks = []) {
    this.target = target;
    this.fallbacks = fallbacks;
  }
  target;
  fallbacks;
  kind() {
    return this.target.kind();
  }
  version() {
    return this.target.version();
  }
  path() {
    return this.target.path();
  }
  exists() {
    return this.target.exists() || this.fallbacks.some((adapter) => adapter.exists());
  }
  empty() {
    return this.target.empty();
  }
  async open() {
    return await this.target.open?.();
  }
  async close() {
    await this.target.close?.();
    await Promise.allSettled(this.fallbacks.map(async (adapter) => await adapter.close?.()));
  }
  reindex(stateOrContext, context) {
    if (!context) {
      return this.target.reindex(stateOrContext);
    }
    return this.target.reindex(stateOrContext, context);
  }
  async search(query, limit, context, signal) {
    return await this.target.search(query, limit, context, signal);
  }
  async sync(context, onProgress) {
    return await this.target.sync(context, onProgress);
  }
  async reset(context, onProgress) {
    await this.target.reset(context, onProgress);
  }
  async ingest(absPath, sourceDir, context) {
    await this.target.ingest(absPath, sourceDir, context);
  }
  remove(absPath, context) {
    this.target.remove(absPath, context);
  }
  accepts(adapter) {
    return this.target.accepts(adapter);
  }
  async migrate(adapter, data) {
    return await this.target.migrate(adapter, data);
  }
  async read() {
    await this.target.open?.();
    const current = await this.target.read();
    if (current) {
      return current;
    }
    for (const fallback of this.fallbacks) {
      await fallback.open?.();
      const legacy = await fallback.read();
      if (!legacy) {
        continue;
      }
      let migrated;
      try {
        migrated = await this.convert(fallback, legacy);
      } catch {
        continue;
      }
      await this.target.create(migrated);
      await Promise.allSettled(
        this.deletableFallbacks().map(async (adapter) => await adapter.delete())
      );
      return await this.target.read() ?? migrated;
    }
    return null;
  }
  async write(data) {
    await this.target.open?.();
    await this.target.write(data);
  }
  async create(data) {
    await this.target.open?.();
    await this.target.create(data);
  }
  async update(data) {
    await this.target.open?.();
    await this.target.update(data);
  }
  async delete() {
    await Promise.all([
      this.target.delete(),
      ...this.deletableFallbacks().map(async (adapter) => await adapter.delete())
    ]);
  }
  /* Keep same-path fallbacks alive so in-place migrations do not delete the new target. */
  deletableFallbacks() {
    const targetPath = this.target.path();
    return this.fallbacks.filter((adapter) => adapter.path() !== targetPath);
  }
  async convert(source, data) {
    const route = this.route(source);
    if (!route) {
      throw new Error(
        `No migration path from ${source.kind()}@${source.version()} to ${this.target.kind()}@${this.target.version()}`
      );
    }
    let migrated = data;
    for (let index2 = 0; index2 < route.length - 1; index2 += 1) {
      migrated = await route[index2 + 1].migrate(route[index2], migrated);
    }
    return migrated;
  }
  /* Breadth-first search across the adapter graph keeps the migration route explicit and minimal. */
  route(source) {
    const targetKey = this.key(this.target);
    const queue = [[source]];
    const seen = /* @__PURE__ */ new Set([this.key(source)]);
    while (queue.length > 0) {
      const currentRoute = queue.shift();
      if (!currentRoute) {
        continue;
      }
      const current = currentRoute[currentRoute.length - 1];
      if (this.key(current) === targetKey) {
        return currentRoute;
      }
      for (const candidate of this.adapters(source)) {
        const candidateKey = this.key(candidate);
        if (seen.has(candidateKey) || !candidate.accepts(current)) {
          continue;
        }
        seen.add(candidateKey);
        queue.push([...currentRoute, candidate]);
      }
    }
    return null;
  }
  adapters(source) {
    return Array.from(
      new Map(
        [source, this.target, ...this.fallbacks].map((adapter) => [this.key(adapter), adapter])
      ).values()
    );
  }
  key(adapter) {
    return `${adapter.kind()}@${adapter.version()}`;
  }
};

// src/adapters/bedrockv1.ts
import mime from "mime";

// src/adapters/jsonv2.ts
import * as fs3 from "node:fs";
import Assembler from "stream-json/assembler.js";
import makeParser from "stream-json/index.js";
var JsonV2Adapter = class _JsonV2Adapter extends AdapterBase {
  /* Match the size-gated legacy JSON streaming cutoff introduced for large indexes. */
  static limit = 256 * 1024 * 1024;
  /**
   * Wrap a concrete v2 JSON source.
   *
   * The source may be a direct path chosen by configuration or a descriptor
   * inherited from a chain adapter that needs to probe a sibling legacy file.
   */
  constructor(source, dimensions) {
    super(source, dimensions, "index.json", "json_v2", JSON_V2_VERSION);
  }
  async read() {
    if (!this.exists()) return null;
    try {
      let raw = null;
      const size = fs3.statSync(this.path()).size;
      if (size >= _JsonV2Adapter.limit) {
        raw = await new Promise((resolve3, reject) => {
          const stream = fs3.createReadStream(this.path(), {
            highWaterMark: JSON_STREAM_CHUNK_BYTES
          });
          const parser = makeParser();
          const assembler = Assembler.connectTo(parser);
          assembler.on("done", (result) => {
            resolve3(result.current);
          });
          stream.on("error", reject);
          parser.on("error", reject);
          stream.pipe(parser);
        });
      } else {
        raw = JSON.parse(fs3.readFileSync(this.path(), "utf-8"));
      }
      if (!this.match(raw)) {
        return null;
      }
      return this.inflate(raw.entries ?? {});
    } catch {
      return null;
    }
  }
  /* v2 is retained purely for backward-compatible reads; writes must migrate elsewhere. */
  async write() {
    throw new Error("json_v2 is a read-only legacy adapter");
  }
  /* Accept only the exact legacy schema and dimensionality this adapter can inflate safely. */
  match(value) {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (value.version !== JSON_V2_VERSION || value.dimensions !== this.dimensions) {
      return false;
    }
    return this.legacy(value.entries ?? {});
  }
  /* Validate the pre-heading legacy entry shape before inflating it. */
  legacy(entries) {
    return Object.values(entries).every((entry) => {
      return typeof entry.relPath === "string" && typeof entry.sourceDir === "string" && typeof entry.mtime === "number" && typeof entry.excerpt === "string" && Array.isArray(entry.vector) && entry.vector.every((value) => typeof value === "number") && entry.vector.length === this.dimensions;
    });
  }
  /* Synthesize the heading and chunk metadata that did not exist in v2 on disk. */
  inflate(entries) {
    const data = this.data({}, "running", JSON_V2_VERSION);
    for (const [absPath, entry] of Object.entries(entries)) {
      data.entries[`${absPath}#0`] = {
        ...entry,
        heading: "intro",
        chunkIndex: 0
      };
    }
    return data;
  }
};
registerIndexAdapter("json_v2", JsonV2Adapter);

// src/adapters/jsonv3.ts
import * as fs4 from "node:fs";
import Assembler2 from "stream-json/assembler.js";
import makeParser2 from "stream-json/index.js";
var JsonV3Adapter = class _JsonV3Adapter extends AdapterBase {
  /* Fall back to streaming before V8 string limits can crash large legacy loads. */
  static limit = 256 * 1024 * 1024;
  /**
   * Wrap a v3 JSON source or an inherited descriptor from a chain adapter.
   *
   * Descriptors keep the adapter wired to the same logical source path when the
   * chain is probing older sibling formats during migration.
   */
  constructor(source, dimensions) {
    super(source, dimensions, "index.json", "json_v3", LEGACY_JSON_VERSION);
  }
  async read() {
    if (!this.exists()) return null;
    try {
      let raw = null;
      const size = fs4.statSync(this.path()).size;
      if (size >= _JsonV3Adapter.limit) {
        raw = await new Promise((resolve3, reject) => {
          const stream = fs4.createReadStream(this.path(), {
            highWaterMark: JSON_STREAM_CHUNK_BYTES
          });
          const parser = makeParser2();
          const assembler = Assembler2.connectTo(parser);
          assembler.on("done", (result) => {
            resolve3(result.current);
          });
          stream.on("error", reject);
          parser.on("error", reject);
          stream.pipe(parser);
        });
      } else {
        raw = JSON.parse(fs4.readFileSync(this.path(), "utf-8"));
      }
      if (!this.match(raw)) {
        return null;
      }
      return this.data(raw.entries ?? {}, void 0, LEGACY_JSON_VERSION);
    } catch {
      return null;
    }
  }
  /* Prefer the fast stringify path and only stream out key-by-key on RangeError. */
  async write(data) {
    const raw = {
      version: LEGACY_JSON_VERSION,
      dimensions: this.dimensions,
      entries: data.entries
    };
    await this.atomic(async (tmp) => {
      try {
        await fs4.promises.writeFile(tmp, JSON.stringify(raw));
      } catch (error) {
        if (error instanceof RangeError) {
          await this.dump(tmp, raw);
          return;
        }
        throw error;
      }
    });
  }
  accepts(adapter) {
    return super.accepts(adapter) || adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION;
  }
  async migrate(adapter, data) {
    if (adapter.kind() === "json_v2" && adapter.version() === JSON_V2_VERSION) {
      return this.migrated(data, LEGACY_JSON_VERSION);
    }
    return await super.migrate(adapter, data);
  }
  /* Validate the legacy v3 shape before normalizing it back into the in-memory form. */
  match(value) {
    return Boolean(
      value && value.version === LEGACY_JSON_VERSION && value.dimensions === this.dimensions && (value.entries === void 0 || typeof value.entries === "object" && value.entries !== null && !Array.isArray(value.entries))
    );
  }
  /* Stream the legacy object out incrementally when stringify would exceed V8 string limits. */
  async dump(file, data) {
    const stream = fs4.createWriteStream(file);
    let fail = null;
    stream.once("error", (error) => {
      fail = error;
    });
    const write = (chunk) => new Promise((resolve3, reject) => {
      if (fail) {
        reject(fail);
        return;
      }
      if (stream.write(chunk)) {
        resolve3();
      } else {
        stream.once("drain", () => fail ? reject(fail) : resolve3());
      }
    });
    try {
      await write(
        `{"version":${JSON.stringify(data.version)},"dimensions":${JSON.stringify(data.dimensions)},"entries":{`
      );
      let first = true;
      for (const key of Object.keys(data.entries ?? {})) {
        const prefix = first ? "" : ",";
        first = false;
        await write(`${prefix}${JSON.stringify(key)}:${JSON.stringify(data.entries?.[key])}`);
      }
      await write("}}");
    } catch (error) {
      stream.destroy();
      throw error;
    }
    await new Promise((resolve3, reject) => {
      stream.end((error) => error ? reject(error) : resolve3());
    });
  }
};

// src/adapters/json.ts
var JsonIndexAdapter = class extends ChainAdapter {
  /**
   * Build a v3 JSON target and wire the v2 fallback to the same logical source.
   *
   * The descriptor preserves the selected file path so migrations happen against
   * sibling files instead of drifting to default names.
   */
  constructor(source, dimensions) {
    const target = new JsonV3Adapter(source, dimensions);
    const descriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path()
    };
    super(target, [new JsonV2Adapter(descriptor, dimensions)]);
  }
};
registerIndexAdapter("json_v3", JsonIndexAdapter);

// src/adapters/jsonv4.ts
import * as fs5 from "node:fs";
import * as readline from "node:readline";
var JsonV4Adapter = class extends AdapterBase {
  /**
   * Wrap a JSONL v4 source or a source descriptor inherited from a chain adapter.
   *
   * The descriptor form keeps migration paths anchored to the same logical index
   * even when probing older sibling files.
   */
  constructor(source, dimensions) {
    super(source, dimensions, "index.jsonl", "jsonl_v4", INDEX_VERSION);
  }
  /* Read the JSONL index line-by-line so large current indexes never require one giant string. */
  async read() {
    if (!this.exists()) return null;
    const lines = readline.createInterface({
      input: fs5.createReadStream(this.path(), { encoding: "utf-8" }),
      crlfDelay: Infinity
    });
    const data = this.data({});
    let ready = false;
    try {
      for await (const line of lines) {
        const row = this.parse(line);
        if (!row) continue;
        if (row.type === "meta") {
          if (row.version !== INDEX_VERSION || row.dimensions !== this.dimensions) {
            return null;
          }
          ready = true;
          data.reindexState = this.state(row.reindexState);
          continue;
        }
        if (!ready || row.type !== "entry") continue;
        if (typeof row.key === "string" && this.valid(row.entry)) {
          data.entries[row.key] = row.entry;
        }
      }
    } finally {
      lines.close();
    }
    return ready ? data : null;
  }
  /* Write v4 as one metadata line plus sorted entry lines for deterministic output. */
  async write(data) {
    await this.atomic(async (tmp) => {
      let fd = null;
      const out = (text2) => {
        if (fd == null) return;
        const buffer = Buffer.from(text2, "utf8");
        let offset = 0;
        while (offset < buffer.length) {
          offset += fs5.writeSync(fd, buffer, offset, buffer.length - offset);
        }
      };
      const line = (text2) => {
        out(text2);
        out("\n");
      };
      try {
        fd = fs5.openSync(tmp, "w");
        line(
          JSON.stringify({
            type: "meta",
            version: INDEX_VERSION,
            dimensions: data.dimensions,
            reindexState: data.reindexState
          })
        );
        for (const key of Object.keys(data.entries).sort()) {
          line(
            JSON.stringify({
              type: "entry",
              key,
              entry: data.entries[key]
            })
          );
        }
      } finally {
        if (fd != null) {
          fs5.closeSync(fd);
        }
      }
    });
  }
  accepts(adapter) {
    return super.accepts(adapter) || adapter.kind() === "json_v3" && adapter.version() === LEGACY_JSON_VERSION;
  }
  async migrate(adapter, data) {
    if (adapter.kind() === "json_v3" && adapter.version() === LEGACY_JSON_VERSION) {
      return this.migrated(data, INDEX_VERSION);
    }
    return await super.migrate(adapter, data);
  }
  /* Ignore malformed lines and only hydrate rows that match the JSONL contract. */
  parse(line) {
    const text2 = line.trim();
    if (text2.length === 0) return null;
    try {
      return JSON.parse(text2);
    } catch {
      return null;
    }
  }
};

// src/adapters/jsonl.ts
var JsonlIndexAdapter = class extends ChainAdapter {
  /* Expose one shared threshold for all legacy whole-object JSON readers. */
  static get threshold() {
    return JsonV3Adapter.limit;
  }
  /* Keep v2 and v3 on the same large-file streaming cutoff. */
  static set threshold(value) {
    JsonV3Adapter.limit = value;
    JsonV2Adapter.limit = value;
  }
  /**
   * Build the JSONL v4 target and bind both legacy JSON fallbacks to the same source.
   *
   * The resulting chain lets callers treat all JSON-backed indexes as one clean
   * adapter even though migration may hop through multiple historical revisions.
   */
  constructor(source, dimensions) {
    const target = new JsonV4Adapter(source, dimensions);
    const descriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path()
    };
    super(target, [
      new JsonV3Adapter(descriptor, dimensions),
      new JsonV2Adapter(descriptor, dimensions)
    ]);
  }
};
registerIndexAdapter("jsonl_v4", JsonlIndexAdapter);

// src/adapters/sqlitev4.ts
import * as fs6 from "node:fs";
import * as path3 from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
var metaTable = sqliteTable("kb_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});
var entryTable = sqliteTable("kb_entries", {
  key: text("key").primaryKey(),
  absPath: text("abs_path").notNull(),
  relPath: text("rel_path").notNull(),
  sourceDir: text("source_dir").notNull(),
  mtime: integer("mtime", { mode: "number" }).notNull(),
  vector: text("vector").notNull(),
  excerpt: text("excerpt").notNull(),
  heading: text("heading").notNull(),
  chunkIndex: integer("chunk_index").notNull()
});
var schema = {
  metaTable,
  entryTable
};
var META_VERSION = "version";
var META_DIMENSIONS = "dimensions";
var META_REINDEX = "reindexState";
var INSERT_BATCH = 200;
var MIGRATIONS_TABLE = "kb_drizzle_migrations";
function resolveMigrationsFolder(metaUrl) {
  const candidates = [
    fileURLToPath3(new URL("../../drizzle", metaUrl)),
    fileURLToPath3(new URL("../drizzle", metaUrl))
  ];
  const resolved = candidates.find(
    (candidate) => fs6.existsSync(path3.join(candidate, "meta", "_journal.json"))
  );
  return resolved ?? candidates[0];
}
var MIGRATIONS_FOLDER = resolveMigrationsFolder(import.meta.url);
var SqliteV4Adapter = class extends AdapterBase {
  /**
   * Wrap a SQLite source path or a descriptor inherited from a migration chain.
   *
   * Descriptors let legacy fallbacks and the SQLite target stay anchored to the
   * same logical configured source while still choosing their own file names.
   */
  constructor(source, dimensions) {
    super(source, dimensions, "index.sqlite", "sqlite_local", INDEX_VERSION);
  }
  /**
   * Open the SQLite database and ensure its schema is available.
   *
   * This doubles as the adapter's constructor-time resource initializer. The
   * Drizzle migrator keeps schema bootstrap hand-authored while still routing all
   * runtime data access through the ORM surface.
   */
  async open() {
    if (this.client) {
      return this.client;
    }
    this.ensure();
    const client = new Database(this.path());
    const orm = drizzle(client, { schema });
    client.pragma("journal_mode = WAL");
    migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER, migrationsTable: MIGRATIONS_TABLE });
    return this.bind({ client, orm });
  }
  /**
   * Close the active SQLite handle.
   *
   * This is the adapter's destructor-equivalent cleanup hook and is safe to call
   * repeatedly because the cached client is cleared after closing.
   */
  async close() {
    this.client?.client.close();
    this.client = void 0;
  }
  /* Read metadata first, then hydrate entries row-by-row into the normalized index shape. */
  async read() {
    if (!this.exists()) return null;
    try {
      const store = await this.open();
      const metaRows = store.orm.select().from(metaTable).all();
      const meta = new Map(metaRows.map((row) => [row.key, row.value]));
      const version = Number.parseInt(meta.get(META_VERSION) ?? "", 10);
      const dimensions = Number.parseInt(meta.get(META_DIMENSIONS) ?? "", 10);
      if (version !== INDEX_VERSION || dimensions !== this.dimensions) {
        return null;
      }
      const data = this.data({}, meta.get(META_REINDEX) ?? void 0, INDEX_VERSION);
      const rows = store.orm.select().from(entryTable).all();
      for (const row of rows) {
        try {
          const vector = JSON.parse(row.vector);
          if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
            continue;
          }
          data.entries[row.key] = {
            relPath: row.relPath,
            sourceDir: row.sourceDir,
            mtime: row.mtime,
            vector,
            excerpt: row.excerpt,
            heading: row.heading,
            chunkIndex: row.chunkIndex
          };
        } catch {
        }
      }
      return data;
    } catch {
      return null;
    }
  }
  /* Rewrite the SQLite index inside one Drizzle transaction so callers see one coherent snapshot. */
  async write(data) {
    const store = await this.open();
    const entries = Object.entries(data.entries);
    store.orm.transaction((tx) => {
      tx.delete(metaTable).run();
      tx.delete(entryTable).run();
      tx.insert(metaTable).values([
        { key: META_VERSION, value: String(INDEX_VERSION) },
        { key: META_DIMENSIONS, value: String(this.dimensions) },
        { key: META_REINDEX, value: data.reindexState }
      ]).run();
      for (let index2 = 0; index2 < entries.length; index2 += INSERT_BATCH) {
        const batch = entries.slice(index2, index2 + INSERT_BATCH).map(([key, entry]) => ({
          key,
          absPath: this.abs(key),
          relPath: entry.relPath,
          sourceDir: entry.sourceDir,
          mtime: entry.mtime,
          vector: JSON.stringify(entry.vector),
          excerpt: entry.excerpt,
          heading: entry.heading,
          chunkIndex: entry.chunkIndex
        }));
        if (batch.length > 0) {
          tx.insert(entryTable).values(batch).run();
        }
      }
    });
  }
  accepts(adapter) {
    return super.accepts(adapter) || adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION;
  }
  async migrate(adapter, data) {
    if (adapter.kind() === "jsonl_v4" && adapter.version() === INDEX_VERSION) {
      return this.migrated(data, INDEX_VERSION);
    }
    return await super.migrate(adapter, data);
  }
  /**
   * Delete the SQLite database after releasing any open handle.
   *
   * This is the destructive cleanup path used by migration chains and explicit
   * adapter deletion requests.
   */
  async delete() {
    await this.close();
    if (!this.exists()) {
      return;
    }
    await fs6.promises.rm(this.path(), { force: true });
  }
  /* Strip the chunk suffix from an entry key so SQLite can store the owning file path explicitly. */
  abs(key) {
    const hash = key.lastIndexOf("#");
    return hash >= 0 ? key.slice(0, hash) : key;
  }
};

// src/adapters/sqlitev4-local.ts
var SqliteV4LocalAdapter = class extends ChainAdapter {
  /**
   * Build the SQLite target and bind all readable legacy fallbacks to the same source.
   *
   * This keeps migration concerns inside the adapter layer so KnowledgeIndex can
   * stay format-agnostic and operate against one clean interface.
   */
  constructor(source, dimensions) {
    const target = new SqliteV4Adapter(source, dimensions);
    const descriptor = {
      selectedKind: target.kind(),
      selectedPath: target.path()
    };
    super(target, [
      new JsonV4Adapter(descriptor, dimensions),
      new JsonV3Adapter(descriptor, dimensions),
      new JsonV2Adapter(descriptor, dimensions)
    ]);
  }
};
registerIndexAdapter("sqlite_local", SqliteV4LocalAdapter);

// src/index-store.ts
var KnowledgeIndex = class {
  config;
  embedder;
  data;
  dirty = false;
  saveTimer = null;
  adapter;
  constructor(config2, embedder2) {
    this.config = config2;
    this.embedder = embedder2;
    this.adapter = createIndexAdapter(config2.kbAdapterSourceUri, config2.dimensions, config2.kbAdapter);
    this.data = this.adapter.empty();
  }
  reindex(state) {
    if (state == null) {
      return this.adapter.reindex(this.context());
    }
    this.adapter.reindex(state, this.context());
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
  /**
   * Load the index from disk.
   */
  async load() {
    const loaded = await this.adapter.read();
    if (loaded) {
      this.data = loaded;
    }
  }
  context() {
    return {
      config: this.config,
      data: this.data,
      embedder: this.embedder,
      scheduleSave: () => this.scheduleSave()
    };
  }
  async save() {
    try {
      await this.adapter.write(this.data);
      this.dirty = false;
    } catch {
    }
  }
  scheduleSave() {
    if (this.saveTimer) return;
    this.dirty = true;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) {
        void this.save().catch((err) => {
          console.error(`knowledge-search: scheduled save failed: ${err.message}`);
        });
      }
    }, 5e3);
  }
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      await this.save();
    }
  }
  /**
   * Scan all configured directories, find new/changed/removed files, update index.
   */
  async sync(onProgress) {
    const summary = await this.adapter.sync(this.context(), onProgress);
    if (summary.added + summary.updated + summary.removed > 0) {
      await this.save();
    }
    return summary;
  }
  async reset(onProgress) {
    await this.adapter.reset(this.context(), onProgress);
    await this.close();
  }
  async rebuild() {
    this.data.entries = {};
    await this.sync();
  }
  async search(query, limit, signal) {
    return await this.adapter.search(query, limit, this.context(), signal);
  }
  /**
   * Ingest a single file into the index (called by watcher).
   */
  async ingest(absPath, sourceDir) {
    await this.adapter.ingest(absPath, sourceDir, this.context());
  }
  remove(absPath) {
    this.adapter.remove(absPath, this.context());
  }
  /** Alias for remove — removes all data for a file path. */
  deleteFile(absPath) {
    this.remove(absPath);
  }
  /** Flush pending saves and release resources. Awaits any in-flight save. */
  async close() {
    await this.flush();
    await this.adapter.close?.();
  }
};

// src/sync-worker.ts
var DEBUG_WORKER = process.env.KNOWLEDGE_SEARCH_DEBUG_WORKER === "1";
function debugWorker(message) {
  if (!DEBUG_WORKER) return;
  process.stderr.write(`knowledge-search worker debug: ${message}
`);
}
process.on("uncaughtException", (err) => {
  process.stderr.write(`knowledge-search worker uncaught: ${err.message}
`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`knowledge-search worker unhandled rejection: ${reason}
`);
  process.exit(1);
});
function loadRuntimeConfig() {
  const raw = process.env.KNOWLEDGE_SEARCH_RUNTIME_CONFIG;
  if (!raw) {
    debugWorker("runtime config env missing; falling back to loadConfig()");
    return loadConfig();
  }
  try {
    debugWorker("using runtime config env payload");
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `knowledge-search worker runtime config parse failed: ${err.message}
`
    );
    return loadConfig();
  }
}
var config = loadRuntimeConfig();
debugWorker(
  `resolved config provider=${config?.provider?.type ?? "none"} dirs=${config?.dirs.length ?? 0} indexDir=${config?.indexDir ?? "none"}`
);
if (!config || !config.provider) {
  debugWorker("exiting early because config or provider is missing");
  process.exit(0);
}
var embedder = createEmbedder(config.provider, config.dimensions);
var index = new KnowledgeIndex(config, embedder);
await index.load();
debugWorker(`loaded index reindexState=${index.reindex()}`);
debugWorker("starting sync()");
index.sync((progress) => {
  if (typeof process.send === "function") {
    const message = {
      type: "knowledge-search-progress",
      progress
    };
    process.send(message);
  }
}).then(({ added, updated, removed }) => {
  debugWorker(`sync resolved added=${added} updated=${updated} removed=${removed}`);
  const result = JSON.stringify({
    added,
    updated,
    removed,
    size: index.size(),
    chunks: index.chunkCount()
  });
  process.stdout.write(result);
  process.exit(0);
}).catch((err) => {
  debugWorker(`sync rejected: ${err.message}`);
  process.stderr.write(err.message);
  process.exit(1);
});
