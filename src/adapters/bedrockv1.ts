import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import mime from "mime";
import type {
  BedrockAgentClientFactory,
  BedrockAgentRuntimeClientFactory,
  BedrockClientEntry,
  BedrockDocumentFailure,
  BedrockLocalDocument,
  BedrockKnowledgeBaseDataSourceType,
  BedrockDocumentStatus,
  BedrockIngestionJobStatus,
  BedrockKnowledgeBaseSyncResult,
  BedrockSyncConfig,
  KnowledgeBaseConfig,
  SearchResult,
} from "../types.js";
import { SearchAdapterBase } from "./base.js";

export type { BedrockAgentClientFactory, BedrockAgentRuntimeClientFactory } from "../types.js";

const DIRECT_BATCH_LIMIT = 25;
const LIST_PAGE_SIZE = 100;
const SEARCH_SCORE_THRESHOLD = 0.15;

const FAILED_DOCUMENT_STATUSES = new Set<BedrockDocumentStatus>([
  "FAILED",
  "PARTIALLY_INDEXED",
  "METADATA_PARTIALLY_INDEXED",
  "METADATA_UPDATE_FAILED",
]);

const PENDING_DOCUMENT_STATUSES = new Set<BedrockDocumentStatus>([
  "PENDING",
  "STARTING",
  "IN_PROGRESS",
  "DELETING",
  "DELETE_IN_PROGRESS",
]);

const ACTIVE_INGESTION_JOB_STATUSES = new Set<BedrockIngestionJobStatus>([
  "STARTING",
  "IN_PROGRESS",
  "STOPPING",
]);

async function createBedrockAgentClient(profile: string, region: string): Promise<any> {
  const { BedrockAgentClient } = await import("@aws-sdk/client-bedrock-agent");
  return new BedrockAgentClient(await bedrockClientOptions(profile, region));
}

async function createBedrockAgentRuntimeClient(profile: string, region: string): Promise<any> {
  const { BedrockAgentRuntimeClient } = await import("@aws-sdk/client-bedrock-agent-runtime");
  return new BedrockAgentRuntimeClient(await bedrockClientOptions(profile, region));
}

function normalizeBedrockResultLocation(location: any): string {
  return (
    location?.s3Location?.uri ??
    location?.webLocation?.url ??
    location?.confluenceLocation?.url ??
    location?.salesforceLocation?.url ??
    location?.sharePointLocation?.url ??
    location?.kendraDocumentLocation?.uri ??
    (location?.customDocumentLocation?.id
      ? `custom-document:${location.customDocumentLocation.id}`
      : undefined) ??
    (location?.sqlLocation?.query ? `sql:${location.sqlLocation.query}` : undefined) ??
    "unknown"
  );
}

function normalizeBedrockDocumentIdentifier(identifier: any): string | null {
  return identifier?.custom?.id ?? identifier?.s3?.uri ?? null;
}

function toBedrockDataSourceType(type: BedrockKnowledgeBaseDataSourceType): "CUSTOM" | "S3" {
  return type === "s3" ? "S3" : "CUSTOM";
}

async function bedrockClientOptions(
  profile: string,
  region: string
): Promise<{ region: string; credentials?: any }> {
  const normalizedProfile = profile.trim();
  if (normalizedProfile.length === 0 || normalizedProfile === "default") {
    return { region };
  }

  const { fromIni } = await import("@aws-sdk/credential-providers");
  return {
    region,
    credentials: fromIni({ profile: normalizedProfile }),
  };
}

/**
 * Versioned Bedrock Knowledge Base search adapter.
 *
 * This is a remote search source rather than a local storage backend. It keeps
 * the Bedrock-specific client lifecycle, result normalization, and API request
 * shape inside the adapter layer so the extension can treat remote KBs like any
 * other search source.
 */
export class BedrockV1Adapter extends SearchAdapterBase<void> {
  private readonly configs: KnowledgeBaseConfig[];
  private runtimeClients = new Map<string, BedrockClientEntry>();
  private agentClients = new Map<string, BedrockClientEntry>();
  private sharedRuntimeClients = new Map<string, any>();
  private sharedAgentClients = new Map<string, any>();
  private sharedRuntimeClientLoads = new Map<string, Promise<any>>();
  private sharedAgentClientLoads = new Map<string, Promise<any>>();

  /**
   * Build a Bedrock search adapter around one or more configured knowledge bases.
   *
   * The optional client factory keeps the adapter easy to unit-test while the
   * default path still lazy-loads the real AWS SDK client.
   */
  constructor(
    configs: KnowledgeBaseConfig[],
    private readonly createRuntimeClient: BedrockAgentRuntimeClientFactory =
      createBedrockAgentRuntimeClient,
    private readonly createAgentClient: BedrockAgentClientFactory = createBedrockAgentClient
  ) {
    super();
    this.configs = [...configs];
  }

  override kind(): "bedrock_v1" {
    return "bedrock_v1";
  }

  override version(): 1 {
    return 1;
  }

  /**
   * Release cached clients and reset lazy init state.
   *
   * The AWS SDK clients do not require an explicit network disconnect, but the
   * cache is cleared so the next session starts from a clean adapter state.
   */
  async close(): Promise<void> {
    this.runtimeClients.clear();
    this.agentClients.clear();
    this.sharedRuntimeClients.clear();
    this.sharedAgentClients.clear();
    this.sharedRuntimeClientLoads.clear();
    this.sharedAgentClientLoads.clear();
  }

  override async search(
    query: string,
    limit: number,
    _context: void,
    signal?: AbortSignal
  ): Promise<SearchResult[]> {
    if (this.configs.length === 0) return [];

    const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");

    const searches = this.configs.map(async (config) => {
      const client = await this.runtimeClientFor(config);
      if (!client) return [];

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

        const response = await client.send(command, { abortSignal: signal });
        const results: SearchResult[] = [];

        for (const result of response.retrievalResults || []) {
          const score = result.score ?? 0;
          if (score < SEARCH_SCORE_THRESHOLD) continue;

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

    return (await Promise.all(searches))
      .flat()
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /**
   * Sync the configured local document set into each Bedrock knowledge base.
   *
   * The public name matches the local storage adapters so callers can trigger a
   * sync without learning a Bedrock-specific verb.
   */
  async sync(config: BedrockSyncConfig): Promise<BedrockKnowledgeBaseSyncResult[]> {
    if (this.configs.length === 0) return [];

    const directDocuments = this.configs.some((entry) => entry.syncMode === "direct")
      ? await this.scanLocalDocuments(config)
      : [];

    return await Promise.all(
      this.configs.map(async (entry) => await this.syncKnowledgeBase(entry, config, directDocuments))
    );
  }

  private async syncKnowledgeBase(
    config: KnowledgeBaseConfig,
    localConfig: BedrockSyncConfig,
    documents: BedrockLocalDocument[]
  ): Promise<BedrockKnowledgeBaseSyncResult> {
    switch (config.syncMode) {
      case "search":
        return this.syncResult(config, {
          knowledgeBaseId: config.id,
          mode: "search",
          status: "IGNORED",
          details: "Search-only knowledge base; no migration requested.",
        });
      case "direct":
        return await this.syncDirectKnowledgeBase(config, localConfig, documents);
      case "ingestion_job":
        return await this.startIngestionJob(config);
      default:
        return {
          knowledgeBaseId: config.id,
          label: config.label,
          mode: config.syncMode,
          status: "FAILED",
          details: `Unsupported sync mode: ${config.syncMode}`,
        };
    }
  }

  private async syncDirectKnowledgeBase(
    config: KnowledgeBaseConfig,
    localConfig: BedrockSyncConfig,
    documents: BedrockLocalDocument[]
  ): Promise<BedrockKnowledgeBaseSyncResult> {
    if (!config.dataSourceId) {
      return this.failedSync(config, "Direct sync requires a dataSourceId.");
    }

    if (config.dataSourceType !== "custom") {
      return this.failedSync(
        config,
        "Direct local sync currently supports Bedrock custom data sources only. Use ingestion_job for staged S3 sources."
      );
    }

    if (localConfig.dirs.length === 0) {
      return this.syncResult(config, {
        knowledgeBaseId: config.id,
        mode: config.syncMode,
        status: "IGNORED",
        details: "No local directories are configured for direct ingestion.",
      });
    }

    try {
      const client = await this.agentClientFor(config);
      const { DeleteKnowledgeBaseDocumentsCommand, IngestKnowledgeBaseDocumentsCommand } =
        await import("@aws-sdk/client-bedrock-agent");

      const remoteIds = new Set(await this.listKnowledgeBaseDocumentIds(client, config));
      const localIds = new Set(documents.map((document) => document.identifier));
      const staleIds = [...remoteIds].filter((identifier) => !localIds.has(identifier));

      let failedDocumentCount = 0;
      const documentFailures: BedrockDocumentFailure[] = [];
      let aggregateStatus: BedrockDocumentStatus = "INDEXED";

      for (const batch of this.chunk(documents, Math.min(config.ingestBatchSize, DIRECT_BATCH_LIMIT))) {
        const response = await client.send(
          new IngestKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: config.id,
            dataSourceId: config.dataSourceId,
            documents: await Promise.all(batch.map(async (document) => await this.toIngestDocument(document))),
          })
        );

        const details = response.documentDetails ?? [];
        failedDocumentCount += this.countFailedDocuments(details);
        documentFailures.push(...this.collectDocumentFailures(details, "ingest"));
        aggregateStatus = this.mergeDocumentStatuses(
          aggregateStatus,
          this.summarizeDocumentStatuses(details)
        );
      }

      for (const batch of this.chunk(staleIds, DIRECT_BATCH_LIMIT)) {
        const response = await client.send(
          new DeleteKnowledgeBaseDocumentsCommand({
            knowledgeBaseId: config.id,
            dataSourceId: config.dataSourceId,
            documentIdentifiers: batch.map((identifier) => ({
              dataSourceType: "CUSTOM",
              custom: { id: identifier },
            })),
          })
        );

        const details = response.documentDetails ?? [];
        failedDocumentCount += this.countFailedDocuments(details);
        documentFailures.push(...this.collectDocumentFailures(details, "delete"));
        aggregateStatus = this.mergeDocumentStatuses(
          aggregateStatus,
          this.summarizeDocumentStatuses(details)
        );
      }

      return this.syncResult(config, {
        knowledgeBaseId: config.id,
        mode: config.syncMode,
        status: aggregateStatus,
        documentCount: documents.length,
        failedDocumentCount,
        ...(documentFailures.length > 0 ? { documentFailures } : {}),
        details:
          staleIds.length > 0
            ? `Upserted ${documents.length} document(s) and removed ${staleIds.length} stale document(s).`
            : `Upserted ${documents.length} document(s).`,
      });
    } catch (err: any) {
      return this.failedSync(config, err.message);
    }
  }

  private async startIngestionJob(config: KnowledgeBaseConfig): Promise<BedrockKnowledgeBaseSyncResult> {
    if (!config.dataSourceId) {
      return this.failedSync(config, "Ingestion jobs require a dataSourceId.");
    }

    try {
      const client = await this.agentClientFor(config);
      const { GetIngestionJobCommand, StartIngestionJobCommand } = await import(
        "@aws-sdk/client-bedrock-agent"
      );

      const started = await client.send(
        new StartIngestionJobCommand({
          knowledgeBaseId: config.id,
          dataSourceId: config.dataSourceId,
        })
      );

      const ingestionJob = started.ingestionJob;
      const jobId = ingestionJob?.ingestionJobId;
      if (!jobId) {
        return this.failedSync(config, "Bedrock did not return an ingestion job id.");
      }

      let status = (ingestionJob?.status ?? "FAILED") as BedrockIngestionJobStatus;
      let current = ingestionJob;
      const deadline = Date.now() + config.maxWaitMs;

      while (ACTIVE_INGESTION_JOB_STATUSES.has(status)) {
        if (Date.now() >= deadline) {
          return this.failedSync(
            config,
            `Timed out waiting for ingestion job ${jobId} to finish.`,
            jobId
          );
        }

        await this.delay(config.pollIntervalMs);

        const polled = await client.send(
          new GetIngestionJobCommand({
            knowledgeBaseId: config.id,
            dataSourceId: config.dataSourceId,
            ingestionJobId: jobId,
          })
        );

        current = polled.ingestionJob ?? current;
        status = (current?.status ?? status) as BedrockIngestionJobStatus;
      }

      return this.syncResult(config, {
        knowledgeBaseId: config.id,
        mode: config.syncMode,
        status,
        jobId,
        documentCount: this.numberFromJobStatistics(
          current?.statistics?.numberOfDocumentsScanned ?? current?.statistics?.numberOfNewDocumentsIndexed
        ),
        failedDocumentCount: this.numberFromJobStatistics(current?.statistics?.numberOfDocumentsFailed),
        details: current?.failureReasons?.join("; ") || undefined,
      });
    } catch (err: any) {
      return this.failedSync(config, err.message);
    }
  }

  private async runtimeClientFor(config: KnowledgeBaseConfig): Promise<any | null> {
    const existing = this.runtimeClients.get(config.id);
    if (existing) {
      return existing.client;
    }

    try {
      const cacheKey = this.cacheKey(config);
      let client = this.sharedRuntimeClients.get(cacheKey);
      if (!client) {
        let pending = this.sharedRuntimeClientLoads.get(cacheKey);
        if (!pending) {
          pending = this.createRuntimeClient(config.profile, config.region)
            .then((created) => {
              this.sharedRuntimeClients.set(cacheKey, created);
              this.sharedRuntimeClientLoads.delete(cacheKey);
              return created;
            })
            .catch((error) => {
              this.sharedRuntimeClientLoads.delete(cacheKey);
              throw error;
            });
          this.sharedRuntimeClientLoads.set(cacheKey, pending);
        }
        client = await pending;
      }

      this.runtimeClients.set(config.id, { client, config });
      return client;
    } catch (err: any) {
      console.error(`knowledge-search: Failed to initialize Bedrock KB client: ${err.message}`);
      return null;
    }
  }

  private async agentClientFor(config: KnowledgeBaseConfig): Promise<any> {
    const existing = this.agentClients.get(config.id);
    if (existing) {
      return existing.client;
    }

    try {
      const cacheKey = this.cacheKey(config);
      let client = this.sharedAgentClients.get(cacheKey);
      if (!client) {
        let pending = this.sharedAgentClientLoads.get(cacheKey);
        if (!pending) {
          pending = this.createAgentClient(config.profile, config.region)
            .then((created) => {
              this.sharedAgentClients.set(cacheKey, created);
              this.sharedAgentClientLoads.delete(cacheKey);
              return created;
            })
            .catch((error) => {
              this.sharedAgentClientLoads.delete(cacheKey);
              throw error;
            });
          this.sharedAgentClientLoads.set(cacheKey, pending);
        }
        client = await pending;
      }

      this.agentClients.set(config.id, { client, config });
      return client;
    } catch (err: any) {
      throw new Error(`Failed to initialize Bedrock KB agent client: ${err.message}`);
    }
  }

  private cacheKey(config: KnowledgeBaseConfig): string {
    return `${config.region}:${config.profile === "default" ? "default-chain" : config.profile}`;
  }

  private async listKnowledgeBaseDocumentIds(client: any, config: KnowledgeBaseConfig): Promise<string[]> {
    const { ListKnowledgeBaseDocumentsCommand } = await import("@aws-sdk/client-bedrock-agent");
    const ids: string[] = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(
        new ListKnowledgeBaseDocumentsCommand({
          knowledgeBaseId: config.id,
          dataSourceId: config.dataSourceId,
          maxResults: LIST_PAGE_SIZE,
          nextToken,
        })
      );

      for (const detail of response.documentDetails ?? []) {
        const identifier = normalizeBedrockDocumentIdentifier(detail.identifier);
        if (identifier) {
          ids.push(identifier);
        }
      }

      nextToken = response.nextToken;
    } while (nextToken);

    return ids;
  }

  private async scanLocalDocuments(config: BedrockSyncConfig): Promise<BedrockLocalDocument[]> {
    const documents: BedrockLocalDocument[] = [];

    for (const sourceDir of config.dirs) {
      await this.walkDirectory(sourceDir, sourceDir, config, documents);
    }

    return documents.sort((left, right) => left.identifier.localeCompare(right.identifier));
  }

  private async walkDirectory(
    sourceDir: string,
    currentDir: string,
    config: BedrockSyncConfig,
    documents: BedrockLocalDocument[]
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.shouldSkip(entry.name, config.excludeDirs)) {
        continue;
      }

      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(sourceDir, absPath, config, documents);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!config.fileExtensions.includes(path.extname(entry.name))) {
        continue;
      }

      const relPath = path.relative(sourceDir, absPath).replace(/\\/g, "/");
      documents.push({
        absPath,
        relPath,
        sourceDir,
        identifier: this.documentIdentifier(sourceDir, relPath),
      });
    }
  }

  private shouldSkip(name: string, excludeDirs: string[]): boolean {
    return name.startsWith(".") || excludeDirs.includes(name);
  }

  private documentIdentifier(sourceDir: string, relPath: string): string {
    return `${sourceDir.replace(/\\/g, "/")}:${relPath}`;
  }

  private async toIngestDocument(document: BedrockLocalDocument): Promise<any> {
    const buffer = await fs.readFile(document.absPath);

    return {
      content: {
        dataSourceType: toBedrockDataSourceType("custom"),
        custom: {
          customDocumentIdentifier: { id: document.identifier },
          sourceType: "IN_LINE",
          inlineContent: {
            type: "BYTE",
            byteContent: {
              mimeType: this.mimeType(document.absPath),
              data: buffer,
            },
          },
        },
      },
      metadata: {
        type: "IN_LINE_ATTRIBUTE",
        inlineAttributes: [
          {
            key: "relPath",
            value: { type: "STRING", stringValue: document.relPath },
          },
          {
            key: "sourceDir",
            value: { type: "STRING", stringValue: document.sourceDir },
          },
        ],
      },
    };
  }

  private mimeType(filePath: string): string {
    return mime.getType(filePath) ?? "application/octet-stream";
  }

  private summarizeDocumentStatuses(details: Array<{ status?: BedrockDocumentStatus }>): BedrockDocumentStatus {
    if (details.length === 0) {
      return "INDEXED";
    }

    for (const detail of details) {
      if (detail.status && FAILED_DOCUMENT_STATUSES.has(detail.status)) {
        return "FAILED";
      }
    }

    for (const detail of details) {
      if (detail.status && PENDING_DOCUMENT_STATUSES.has(detail.status)) {
        return detail.status;
      }
    }

    return "INDEXED";
  }

  private mergeDocumentStatuses(
    current: BedrockDocumentStatus,
    next: BedrockDocumentStatus
  ): BedrockDocumentStatus {
    if (FAILED_DOCUMENT_STATUSES.has(current) || FAILED_DOCUMENT_STATUSES.has(next)) {
      return "FAILED";
    }

    if (PENDING_DOCUMENT_STATUSES.has(current)) {
      return current;
    }

    if (PENDING_DOCUMENT_STATUSES.has(next)) {
      return next;
    }

    return next;
  }

  private countFailedDocuments(details: Array<{ status?: BedrockDocumentStatus }>): number {
    return details.filter((detail) => detail.status && FAILED_DOCUMENT_STATUSES.has(detail.status)).length;
  }

  private collectDocumentFailures(
    details: Array<{ identifier?: any; status?: BedrockDocumentStatus; statusReason?: string }>,
    operation: BedrockDocumentFailure["operation"]
  ): BedrockDocumentFailure[] {
    return details.flatMap((detail) => {
      if (!detail.status || !FAILED_DOCUMENT_STATUSES.has(detail.status)) {
        return [];
      }

      return [
        {
          identifier: normalizeBedrockDocumentIdentifier(detail.identifier) ?? "unknown",
          operation,
          status: detail.status,
          ...(detail.statusReason ? { reason: detail.statusReason } : {}),
        },
      ];
    });
  }

  private failedSync(
    config: KnowledgeBaseConfig,
    details: string,
    jobId?: string
  ): BedrockKnowledgeBaseSyncResult {
    return this.syncResult(config, {
      knowledgeBaseId: config.id,
      mode: config.syncMode,
      status: "FAILED",
      ...(jobId ? { jobId } : {}),
      details,
    });
  }

  private syncResult(
    config: KnowledgeBaseConfig,
    result: Omit<BedrockKnowledgeBaseSyncResult, "label"> & { label?: string }
  ): BedrockKnowledgeBaseSyncResult {
    return {
      knowledgeBaseId: result.knowledgeBaseId,
      mode: result.mode,
      status: result.status,
      ...(config.label ? { label: config.label } : {}),
      ...(result.documentCount != null ? { documentCount: result.documentCount } : {}),
      ...(result.failedDocumentCount != null ? { failedDocumentCount: result.failedDocumentCount } : {}),
      ...(result.documentFailures?.length ? { documentFailures: result.documentFailures } : {}),
      ...(result.jobId ? { jobId: result.jobId } : {}),
      ...(result.details ? { details: result.details } : {}),
    };
  }

  private numberFromJobStatistics(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      batches.push(items.slice(index, index + size));
    }
    return batches;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}