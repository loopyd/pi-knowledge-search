# pi-knowledge-search

Semantic search over local files for [pi](https://github.com/badlogic/pi). Indexes directories of text/markdown files using vector embeddings, watches for changes in real-time, and exposes a `knowledge_search` tool the LLM can call.

## Install

**Recommended:** Install [pi-total-recall](https://github.com/samfoy/pi-total-recall) to get the complete context stack — persistent memory, session history search, and local knowledge search in one package:

```bash
pi install pi-total-recall
```

Or install pi-knowledge-search standalone:

```bash
pi install git:github.com/samfoy/pi-knowledge-search
```

Or try without installing:

```bash
pi -e git:github.com/samfoy/pi-knowledge-search
```

## Setup

Run the interactive setup command inside pi:

```
/knowledge-search-setup
```

This walks you through:

1. **Directories** to index (comma-separated paths)
2. **File extensions** to include (default: `.md, .txt`)
3. **Directories to exclude** (default: `node_modules, .git, .obsidian, .trash`)
4. **Embedding provider** — OpenAI, OpenAI-compatible (local/self-hosted), AWS Bedrock, or Ollama

Config is saved to the nearest project `.pi/knowledge-search.json` when a project `.pi/settings.json` or `.pi/knowledge-search.json` is present; otherwise it falls back to `~/.pi/knowledge-search.json`. Relative paths resolve from the active config directory. Run `/reload` to activate.

### Config file

You can also edit the config file directly:

```json
{
  "dirs": ["~/notes", "~/docs"],
  "fileExtensions": [".md", ".txt"],
  "excludeDirs": ["node_modules", ".git", ".obsidian", ".trash"],
  "provider": {
    "type": "openai",
    "model": "text-embedding-3-small"
  }
}
```

The API key for OpenAI can be set in the config file (`"apiKey": "sk-..."`) or via the `OPENAI_API_KEY` environment variable.

<details>
<summary>Bedrock config</summary>

```json
{
  "dirs": ["~/vault"],
  "provider": {
    "type": "bedrock",
    "profile": "my-aws-profile",
    "region": "us-west-2",
    "model": "amazon.titan-embed-text-v2:0"
  }
}
```

Requires the AWS SDK and valid credentials for the specified profile.

</details>

<details>
<summary>Ollama config (free, local)</summary>

```json
{
  "dirs": ["~/notes"],
  "provider": {
    "type": "ollama",
    "url": "http://localhost:11434",
    "model": "nomic-embed-text"
  }
}
```

Requires [Ollama](https://ollama.ai) running locally:

```bash
ollama serve
ollama pull nomic-embed-text
```

</details>

<details>
<summary>OpenAI-compatible config (free, local/self-hosted)</summary>

Any server that exposes an OpenAI-compatible `/v1/embeddings` endpoint works:
[llama.cpp](https://github.com/ggml-org/llama.cpp), [vLLM](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html),
[litellm](https://docs.litellm.ai/), [Ollama's OpenAI-compatibility mode](https://ollama.com/blog/openai-compatibility), etc.

```json
{
  "dirs": ["~/notes"],
  "provider": {
    "type": "openai-compatible",
    "baseUrl": "http://127.0.0.1:8080",
    "apiKey": "your-local-key",
    "model": "qwen3-embeddings"
  }
}
```

The `baseUrl` should be your server root **without** a trailing `/v1` path — the embedder appends `/v1/embeddings` automatically.

For example with llama-cpp-python:

```bash
python -m llama_cpp.server --model ./models/qwen3-embedding.gguf --port 8080
```

Then configure knowledge-search to point at `http://127.0.0.1:8080` as shown above.

The `apiKey` field is optional; omit it if your runner doesn't require authentication.

</details>

### Bedrock Knowledge Bases

You can add [Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html) as additional search sources. These are managed RAG services — Amazon handles chunking, embedding, and vector storage. pi-knowledge-search queries them at search time and merges results with local file results.

Bedrock KB entries now support three modes:

1. `search` — query an existing knowledge base only.
2. `direct` — push local files into a Bedrock `custom` data source with the direct document APIs.
3. `ingestion_job` — ask Bedrock to re-sync a staged data source such as S3 via `StartIngestionJob`.

Add via command:

```
/knowledge-add-kb
```

Inspect the saved Bedrock KB configuration:

```
/knowledge-bedrock-status
```

Or add directly to the config file:

```json
{
  "dirs": ["~/notes"],
  "provider": { "type": "openai" },
  "knowledgeBases": [
    {
      "id": "XXXXXXXXXX",
      "region": "us-east-1",
      "profile": "default",
      "label": "Team docs",
      "syncMode": "search"
    }
  ]
}
```

To sync local files into a Bedrock custom data source:

```json
{
  "dirs": ["~/notes"],
  "knowledgeBases": [
    {
      "id": "KB12345678",
      "label": "Team docs",
      "profile": "my-work-profile",
      "region": "us-east-1",
      "dataSourceId": "DS12345678",
      "dataSourceType": "custom",
      "syncMode": "direct",
      "ingestBatchSize": 25
    }
  ]
}
```

To trigger a staged S3 sync job instead:

```json
{
  "knowledgeBases": [
    {
      "id": "KB12345678",
      "label": "Staged docs",
      "profile": "my-work-profile",
      "region": "us-east-1",
      "dataSourceId": "DS12345678",
      "dataSourceType": "s3",
      "syncMode": "ingestion_job",
      "pollIntervalMs": 2000,
      "maxWaitMs": 300000
    }
  ]
}
```

You can use Knowledge Bases alongside local file indexing, or on their own (omit `dirs` and `provider` for KB-only mode).

KB-only config:

```json
{
  "knowledgeBases": [
    {
      "id": "XXXXXXXXXX",
      "region": "us-east-1",
      "profile": "my-work-profile",
      "label": "Engineering wiki"
    }
  ]
}
```

Requires the AWS SDK and valid credentials with `bedrock:Retrieve` permissions.

For sync workflows, the same profile also needs the Bedrock knowledge-base document or ingestion-job permissions required by your selected mode. See [docs/bedrock-knowledge-bases.md](docs/bedrock-knowledge-bases.md) for mode details and AWS behavior notes.

### Environment variable overrides

Every config field can be overridden via environment variables. This is useful for CI or when you want different settings per shell session. See [env-vars.md](docs/env-vars.md) for the full list.

## How it works

1. On session start, loads the index from disk and incrementally syncs — only re-embeds new or modified files
2. Starts a file watcher for real-time updates (debounced, 2s)
3. Registers a `knowledge_search` tool the LLM calls with natural language queries
4. Returns ranked results with file paths, relevance scores, and content excerpts

The index is stored at `~/.pi/knowledge-search/index.json`.

## Commands

| Command                   | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `/knowledge-search-setup`  | Interactive setup wizard                        |
| `/knowledge-add-kb`        | Add a Bedrock Knowledge Base as a search source |
| `/knowledge-bedrock-status`| Show the current Bedrock KB configuration       |
| `/knowledge-bedrock-sync`  | Sync configured Bedrock KB data sources         |
| `/knowledge-reindex`       | Force a full re-index                           |

## Performance

Typical numbers for ~500 markdown files (~20MB):

| Operation                     | Time   |
| ----------------------------- | ------ |
| Full index build              | ~7s    |
| Incremental sync (no changes) | ~12ms  |
| File re-embed (watcher)       | ~200ms |
| Search query                  | ~250ms |
| Index file size               | ~5MB   |

## License

MIT
