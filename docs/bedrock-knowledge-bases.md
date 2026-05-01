# Bedrock Knowledge Bases

pi-knowledge-search can query Bedrock Knowledge Bases at search time and can now drive two documented Bedrock sync paths for configured data sources.

## Modes

### `search`

Use this when the knowledge base is managed elsewhere and pi only needs retrieval.

```json
{
  "knowledgeBases": [
    {
      "id": "KB12345678",
      "region": "us-east-1",
      "profile": "default",
      "syncMode": "search"
    }
  ]
}
```

### `direct`

Use this for Bedrock `custom` data sources. `/knowledge-bedrock-sync` will:

1. Scan the configured local `dirs` using the same `fileExtensions` and `excludeDirs` rules as the local index.
2. Upload matching files with `IngestKnowledgeBaseDocuments`.
3. List existing documents with `ListKnowledgeBaseDocuments`.
4. Remove stale Bedrock documents with `DeleteKnowledgeBaseDocuments`.

```json
{
  "dirs": ["~/notes"],
  "fileExtensions": [".md", ".txt"],
  "knowledgeBases": [
    {
      "id": "KB12345678",
      "label": "Team docs",
      "profile": "work",
      "region": "us-east-1",
      "dataSourceId": "DS12345678",
      "dataSourceType": "custom",
      "syncMode": "direct",
      "ingestBatchSize": 25
    }
  ]
}
```

### `ingestion_job`

Use this for staged sources such as S3 when Bedrock should perform its own crawl and delta detection. `/knowledge-bedrock-sync` will call `StartIngestionJob` and poll `GetIngestionJob` until completion or timeout.

```json
{
  "knowledgeBases": [
    {
      "id": "KB12345678",
      "label": "Staged docs",
      "profile": "work",
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

## Command

Run `/knowledge-bedrock-status` to inspect the saved Bedrock configuration and see whether each entry is currently active in the running session.

Run `/knowledge-bedrock-sync` to execute the configured Bedrock sync mode for each configured knowledge base.

The command reports per-KB status, document counts when Bedrock returns them, and the ingestion job id for staged syncs.

## AWS Behavior Notes

1. `direct` mode is limited to Bedrock `custom` data sources.
2. `ingestion_job` mode is the supported path for staged S3 sources in this extension.
3. Bedrock direct-ingestion APIs and ingestion jobs should not be mixed against the same S3-backed data source at the same time.
4. Bedrock-supported source formats and quotas come from AWS. Common documented formats include `.txt`, `.md`, `.html`, `.doc`, `.docx`, `.csv`, `.xls`, `.xlsx`, and `.pdf`.

## Permissions

Search-only mode requires retrieval permissions such as `bedrock:Retrieve`.

Sync modes also require the Bedrock Knowledge Bases permissions needed for the selected API path:

1. `direct`: document list, ingest, and delete permissions.
2. `ingestion_job`: ingestion job start and read permissions.

Refer to the AWS Bedrock Knowledge Bases documentation for the exact IAM actions required in your region and account setup.