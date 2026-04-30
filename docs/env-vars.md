# Environment Variable Reference

All settings can be overridden via environment variables. The config file (`~/.pi/knowledge-search.json`) is checked first, then env vars override individual fields.

| Variable | Description | Default |
|----------|-------------|---------|
| `KNOWLEDGE_SEARCH_CONFIG` | Path to config file | `~/.pi/knowledge-search.json` |
| `KNOWLEDGE_SEARCH_DIRS` | Comma-separated directories to index | *(from config file)* |
| `KNOWLEDGE_SEARCH_EXTENSIONS` | Comma-separated file extensions | `.md,.txt` |
| `KNOWLEDGE_SEARCH_EXCLUDE` | Comma-separated directory names to skip | `node_modules,.git,.obsidian,.trash` |
| `KNOWLEDGE_SEARCH_DIMENSIONS` | Embedding vector dimensions | `512` |
| `KNOWLEDGE_SEARCH_INDEX_DIR` | Where to store the index | `~/.pi/knowledge-search` |
| `KNOWLEDGE_SEARCH_LOG_FILE` | Log file path for diagnostics | `~/.pi/knowledge-search/logs/knowledge-search.log` |
| `KNOWLEDGE_SEARCH_VERBOSE` | Verbose logging toggle (`1/0`, `true/false`) | `true` |
| `KNOWLEDGE_SEARCH_QUARANTINE_ENABLED` | Quarantine malformed chunks before embedding | `true` |
| `KNOWLEDGE_SEARCH_PROVIDER` | Provider type: `openai`, `bedrock`, `ollama` | `openai` |

### OpenAI

| Variable | Default |
|----------|---------|
| `OPENAI_API_KEY` or `KNOWLEDGE_SEARCH_OPENAI_API_KEY` | *(required)* |
| `KNOWLEDGE_SEARCH_OPENAI_MODEL` | `text-embedding-3-small` |

### Bedrock

| Variable | Default |
|----------|---------|
| `KNOWLEDGE_SEARCH_BEDROCK_PROFILE` | `default` |
| `KNOWLEDGE_SEARCH_BEDROCK_REGION` | `us-east-1` |
| `KNOWLEDGE_SEARCH_BEDROCK_MODEL` | `amazon.titan-embed-text-v2:0` |

### Ollama

| Variable | Default |
|----------|---------|
| `KNOWLEDGE_SEARCH_OLLAMA_URL` | `http://localhost:11434` |
| `KNOWLEDGE_SEARCH_OLLAMA_MODEL` | `nomic-embed-text` |
