import * as fs from "node:fs";
import * as path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

function parseFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  return /^(1|true|yes|on|debug|verbose)$/i.test(value.trim());
}

function resolveSettings(): {
  verboseEnabled: boolean;
  logFile: string;
} {
  const home = process.env.HOME || "/tmp";
  const defaultDir = path.join(home, ".pi", "knowledge-search", "logs");
  const logDir = process.env.KNOWLEDGE_SEARCH_LOG_DIR || defaultDir;
  const logFile = process.env.KNOWLEDGE_SEARCH_LOG_FILE || path.join(logDir, "knowledge-search.log");

  return {
    verboseEnabled: parseFlag(process.env.KNOWLEDGE_SEARCH_VERBOSE, true),
    logFile,
  };
}

const initializedPaths = new Set<string>();

function ensureLogFile(logFile: string): void {
  if (initializedPaths.has(logFile)) return;
  initializedPaths.add(logFile);

  const logDir = path.dirname(logFile);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Ignore logging initialization failures.
  }
}

function redact(value: string): string {
  // Redact common bearer/api key patterns before writing to disk.
  return value
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/g, "Bearer [REDACTED]")
    .replace(/"apiKey"\s*:\s*"[^"]+"/gi, '"apiKey":"[REDACTED]"')
    .replace(/OPENAI_API_KEY=\S+/g, "OPENAI_API_KEY=[REDACTED]");
}

function safeSerialize(meta: unknown): string | undefined {
  if (meta == null) return undefined;
  try {
    const text = JSON.stringify(meta);
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  } catch (err: any) {
    return JSON.stringify({
      serializationError: err?.message ?? "unknown",
    });
  }
}

function appendLine(level: Level, scope: string, message: string, meta?: unknown): void {
  const settings = resolveSettings();
  ensureLogFile(settings.logFile);

  const ts = new Date().toISOString();
  const record: Record<string, unknown> = {
    ts,
    level,
    pid: process.pid,
    scope,
    message: redact(message),
  };

  const serializedMeta = safeSerialize(meta);
  if (serializedMeta) {
    record.meta = serializedMeta;
  }

  try {
    fs.appendFileSync(settings.logFile, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Ignore logging write failures.
  }
}

export function isKnowledgeSearchVerbose(): boolean {
  return resolveSettings().verboseEnabled;
}

export function getKnowledgeSearchLogPath(): string {
  return resolveSettings().logFile;
}

export function logDebug(scope: string, message: string, meta?: unknown): void {
  if (!resolveSettings().verboseEnabled) return;
  appendLine("debug", scope, message, meta);
}

export function logInfo(scope: string, message: string, meta?: unknown): void {
  if (!resolveSettings().verboseEnabled) return;
  appendLine("info", scope, message, meta);
}

export function logWarn(scope: string, message: string, meta?: unknown): void {
  appendLine("warn", scope, message, meta);
}

export function logError(scope: string, message: string, meta?: unknown): void {
  appendLine("error", scope, message, meta);
}

export function countUnpairedSurrogates(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;

    if (isHigh) {
      const next = text.charCodeAt(i + 1);
      const nextIsLow = next >= 0xdc00 && next <= 0xdfff;
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
