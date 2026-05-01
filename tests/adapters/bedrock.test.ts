import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BedrockAdapter } from "../../src/adapters/index.js";

describe("BedrockAdapter", () => {
  it("reuses shared clients and normalizes search results", async () => {
    const created: string[] = [];
    const requests: string[] = [];

    const adapter = new BedrockAdapter(
      [
        {
          id: "kb-alpha",
          label: "Docs",
          profile: "default",
          region: "us-east-1",
          syncMode: "search",
          ingestBatchSize: 25,
          pollIntervalMs: 2000,
          maxWaitMs: 300000,
        },
        {
          id: "kb-beta",
          profile: "default",
          region: "us-east-1",
          syncMode: "search",
          ingestBatchSize: 25,
          pollIntervalMs: 2000,
          maxWaitMs: 300000,
        },
      ],
      async (profile, region) => {
        created.push(`${profile}:${region}`);
        return {
          async send(command: any) {
            requests.push(command.input.knowledgeBaseId);
            if (command.input.knowledgeBaseId === "kb-alpha") {
              return {
                retrievalResults: [
                  {
                    score: 0.91,
                    content: { text: "alpha result" },
                    location: { s3Location: { uri: "s3://bucket/alpha.md" } },
                  },
                  {
                    score: 0.05,
                    content: { text: "below threshold" },
                    location: { s3Location: { uri: "s3://bucket/ignored.md" } },
                  },
                ],
              };
            }

            return {
              retrievalResults: [
                {
                  score: 0.63,
                  content: { text: "beta result" },
                  location: { webLocation: { url: "https://example.com/beta" } },
                },
              ],
            };
          },
        };
      }
    );

    const results = await adapter.search("history", 5, undefined);

    assert.deepStrictEqual(created, ["default:us-east-1"]);
    assert.deepStrictEqual(requests, ["kb-alpha", "kb-beta"]);
    assert.deepStrictEqual(results, [
      {
        path: "s3://bucket/alpha.md [Docs]",
        score: 0.91,
        excerpt: "alpha result",
        heading: "",
      },
      {
        path: "https://example.com/beta [KB]",
        score: 0.63,
        excerpt: "beta result",
        heading: "",
      },
    ]);
  });

  it("direct-syncs custom knowledge bases and deletes stale documents", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-bedrock-"));
    const nestedDir = path.join(tmpDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "alpha.md"), "# Alpha\n\nOne");
    fs.writeFileSync(path.join(nestedDir, "beta.txt"), "Beta");

    const ingested: string[][] = [];
    const ingestedMimeTypes: string[][] = [];
    const deleted: string[][] = [];

    try {
      const adapter = new BedrockAdapter(
        [
          {
            id: "kb-custom",
            label: "Docs",
            profile: "default",
            region: "us-east-1",
            dataSourceId: "ds-custom",
            dataSourceType: "custom",
            syncMode: "direct",
            ingestBatchSize: 2,
            pollIntervalMs: 1,
            maxWaitMs: 100,
          },
        ],
        undefined,
        async () => ({
          async send(command: any) {
            switch (command.constructor.name) {
              case "ListKnowledgeBaseDocumentsCommand":
                return {
                  documentDetails: [
                    {
                      identifier: {
                        dataSourceType: "CUSTOM",
                        custom: { id: `${tmpDir.replace(/\\/g, "/")}:alpha.md` },
                      },
                      status: "INDEXED",
                    },
                    {
                      identifier: {
                        dataSourceType: "CUSTOM",
                        custom: { id: `${tmpDir.replace(/\\/g, "/")}:stale.md` },
                      },
                      status: "INDEXED",
                    },
                  ],
                };
              case "IngestKnowledgeBaseDocumentsCommand":
                ingested.push(
                  command.input.documents.map(
                    (document: any) => document.content.custom.customDocumentIdentifier.id
                  )
                );
                ingestedMimeTypes.push(
                  command.input.documents.map(
                    (document: any) => document.content.custom.inlineContent.byteContent.mimeType
                  )
                );
                return {
                  documentDetails: command.input.documents.map((document: any) => ({
                    identifier: {
                      dataSourceType: "CUSTOM",
                      custom: { id: document.content.custom.customDocumentIdentifier.id },
                    },
                    status: "INDEXED",
                  })),
                };
              case "DeleteKnowledgeBaseDocumentsCommand":
                deleted.push(
                  command.input.documentIdentifiers.map((identifier: any) => identifier.custom.id)
                );
                return {
                  documentDetails: command.input.documentIdentifiers.map((identifier: any) => ({
                    identifier: {
                      dataSourceType: "CUSTOM",
                      custom: { id: identifier.custom.id },
                    },
                    status: "INDEXED",
                  })),
                };
              default:
                throw new Error(`Unexpected command: ${command.constructor.name}`);
            }
          },
        })
      );

      const results = await adapter.sync({
        dirs: [tmpDir],
        fileExtensions: [".md", ".txt"],
        excludeDirs: [],
      });

      assert.deepStrictEqual(ingested, [
        [
          `${tmpDir.replace(/\\/g, "/")}:alpha.md`,
          `${tmpDir.replace(/\\/g, "/")}:nested/beta.txt`,
        ],
      ]);
      assert.deepStrictEqual(ingestedMimeTypes, [["text/markdown", "text/plain"]]);
      assert.deepStrictEqual(deleted, [[`${tmpDir.replace(/\\/g, "/")}:stale.md`]]);
      assert.deepStrictEqual(results, [
        {
          knowledgeBaseId: "kb-custom",
          label: "Docs",
          mode: "direct",
          status: "INDEXED",
          documentCount: 2,
          failedDocumentCount: 0,
          details: "Upserted 2 document(s) and removed 1 stale document(s).",
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports per-document failures from direct Bedrock sync responses", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-bedrock-"));
    fs.writeFileSync(path.join(tmpDir, "alpha.md"), "# Alpha\n\nOne");

    try {
      const adapter = new BedrockAdapter(
        [
          {
            id: "kb-custom",
            label: "Docs",
            profile: "default",
            region: "us-east-1",
            dataSourceId: "ds-custom",
            dataSourceType: "custom",
            syncMode: "direct",
            ingestBatchSize: 2,
            pollIntervalMs: 1,
            maxWaitMs: 100,
          },
        ],
        undefined,
        async () => ({
          async send(command: any) {
            switch (command.constructor.name) {
              case "ListKnowledgeBaseDocumentsCommand":
                return {
                  documentDetails: [
                    {
                      identifier: {
                        dataSourceType: "CUSTOM",
                        custom: { id: `${tmpDir.replace(/\\/g, "/")}:stale.md` },
                      },
                      status: "INDEXED",
                    },
                  ],
                };
              case "IngestKnowledgeBaseDocumentsCommand":
                return {
                  documentDetails: command.input.documents.map((document: any) => ({
                    identifier: {
                      dataSourceType: "CUSTOM",
                      custom: { id: document.content.custom.customDocumentIdentifier.id },
                    },
                    status: "FAILED",
                    statusReason: "Access denied",
                  })),
                };
              case "DeleteKnowledgeBaseDocumentsCommand":
                return {
                  documentDetails: command.input.documentIdentifiers.map((identifier: any) => ({
                    identifier: {
                      dataSourceType: "CUSTOM",
                      custom: { id: identifier.custom.id },
                    },
                    status: "METADATA_UPDATE_FAILED",
                    statusReason: "Delete denied",
                  })),
                };
              default:
                throw new Error(`Unexpected command: ${command.constructor.name}`);
            }
          },
        })
      );

      const results = await adapter.sync({
        dirs: [tmpDir],
        fileExtensions: [".md"],
        excludeDirs: [],
      });

      assert.deepStrictEqual(results, [
        {
          knowledgeBaseId: "kb-custom",
          label: "Docs",
          mode: "direct",
          status: "FAILED",
          documentCount: 1,
          failedDocumentCount: 2,
          documentFailures: [
            {
              identifier: `${tmpDir.replace(/\\/g, "/")}:alpha.md`,
              operation: "ingest",
              status: "FAILED",
              reason: "Access denied",
            },
            {
              identifier: `${tmpDir.replace(/\\/g, "/")}:stale.md`,
              operation: "delete",
              status: "METADATA_UPDATE_FAILED",
              reason: "Delete denied",
            },
          ],
          details: "Upserted 1 document(s) and removed 1 stale document(s).",
        },
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("starts and polls ingestion jobs for staged Bedrock data sources", async () => {
    const agentCalls: string[] = [];

    const adapter = new BedrockAdapter(
      [
        {
          id: "kb-stage",
          profile: "default",
          region: "us-east-1",
          dataSourceId: "ds-stage",
          dataSourceType: "s3",
          syncMode: "ingestion_job",
          ingestBatchSize: 25,
          pollIntervalMs: 1,
          maxWaitMs: 50,
        },
      ],
      undefined,
      async () => ({
        async send(command: any) {
          agentCalls.push(command.constructor.name);
          if (command.constructor.name === "StartIngestionJobCommand") {
            return {
              ingestionJob: {
                ingestionJobId: "job-123",
                status: "STARTING",
              },
            };
          }

          return {
            ingestionJob: {
              ingestionJobId: "job-123",
              status: "COMPLETE",
            },
          };
        },
      })
    );

    const results = await adapter.sync({
      dirs: [],
      fileExtensions: [".md"],
      excludeDirs: [],
    });

    assert.deepStrictEqual(agentCalls, ["StartIngestionJobCommand", "GetIngestionJobCommand"]);
    assert.deepStrictEqual(results, [
      {
        knowledgeBaseId: "kb-stage",
        mode: "ingestion_job",
        status: "COMPLETE",
        jobId: "job-123",
      },
    ]);
  });
});
