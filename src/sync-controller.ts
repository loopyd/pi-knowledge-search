import { type ChildProcess, fork, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { getConfigPath } from "./config.js";
import { StatusBar } from "./status-bar.js";
import type {
  Config,
  ControllableIndex,
  KnowledgeSearchProgressMessage,
  RealtimeWatcher,
  StartOptions,
  SyncProgress,
  SyncWorkerResult,
} from "./types.js";

export type { ControllableIndex, StartOptions } from "./types.js";

export class SyncController {
  private static instance: SyncController | null = null;

  static shared(): SyncController {
    if (!SyncController.instance) {
      SyncController.instance = new SyncController();
    }
    return SyncController.instance;
  }

  private activeWorker: ChildProcess | null = null;
  private currentConfig: Config | null = null;
  private index: ControllableIndex | null = null;
  private realtime: RealtimeWatcher | null = null;
  private ctx: any;
  private statusBar = StatusBar.shared();

  private syncDone = true;
  private workerExitExpected = false;
  private workerRestartCount = 0;
  private workerRestartWindowStart = Date.now();
  private workerRestartTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly MAX_WORKER_RESTARTS = 3;
  private readonly RESTART_WINDOW_MS = 60_000;
  private readonly WORKER_SHUTDOWN_GRACE_MS = 10_000;

  private constructor() {}

  done(): boolean {
    return this.syncDone;
  }

  async restart(options: StartOptions): Promise<void> {
    if (!options.index) {
      await this.start(options, { respectPausedState: false });
      return;
    }

    const index = options.index;
    this.currentConfig = options.config;
    this.index = index;
    this.realtime = options.realtime ?? null;
    this.ctx = options.ctx;
    this.statusBar.start(this.ctx, this.currentConfig);
    this.realtime?.stop();
    index.reindex?.("running");

    await index.reset?.((progress: SyncProgress) => {
      this.statusBar.progress(progress);
    });

    await this.start(options, { respectPausedState: false });
  }

  async pause(ctx?: any): Promise<void> {
    this.clearWorkerRestartTimer();
    this.workerExitExpected = true;
    this.realtime?.stop();
    if (ctx) {
      this.ctx = ctx;
    }

    await this.stopActiveWorker("reindex_pause");
    this.index?.reindex?.("paused");
    await this.index?.flush?.();
    this.statusBar.start(this.ctx, this.currentConfig);
    this.statusBar.pause(this.ctx, this.currentConfig);
    this.syncDone = true;
  }

  async start(options: StartOptions, behavior: { respectPausedState?: boolean } = {}): Promise<void> {
    const { respectPausedState = true } = behavior;
    this.clearWorkerRestartTimer();
    this.workerExitExpected = false;
    await this.stopActiveWorker("session_start");

    this.currentConfig = options.config;
    this.index = options.index;
    this.realtime = options.realtime ?? null;
    this.ctx = options.ctx;
    this.statusBar.start(this.ctx, this.currentConfig);
    this.realtime?.stop();

    this.workerRestartCount = 0;
    this.workerRestartWindowStart = Date.now();

    if (!this.index) {
      this.syncDone = true;
      return;
    }

    if (this.currentConfig?.dirs.length === 0 || this.currentConfig?.kbAdapter === "json_v2") {
      this.syncDone = true;
      this.statusBar.clear();
      return;
    }

    if (respectPausedState && this.index.reindex?.() === "paused") {
      this.statusBar.pause(this.ctx, this.currentConfig);
      this.syncDone = true;
      return;
    }

    this.statusBar.progress({
      phase: "init",
      processed: 0,
      total: 0,
      added: 0,
      updated: 0,
      removed: 0,
    });

    await this.index.flush?.();
    this.killStaleWorkerFromPidFile();
    this.spawn();
  }

  async stop(): Promise<void> {
    const wasRunning = !this.syncDone;
    this.clearWorkerRestartTimer();
    this.workerExitExpected = true;
    this.realtime?.stop();
    await this.stopActiveWorker("session_shutdown");
    if (wasRunning) {
      this.index?.reindex?.("paused");
    }
    this.statusBar.clear();
    this.statusBar.stop();
    this.syncDone = true;
  }

  private clearWorkerRestartTimer(): void {
    if (!this.workerRestartTimer) return;
    clearTimeout(this.workerRestartTimer);
    this.workerRestartTimer = null;
  }

  private workerPidFilePath(): string | null {
    if (!this.currentConfig) return null;
    return join(this.currentConfig.indexDir, "sync-worker.pid");
  }

  private writeWorkerPid(pid: number): void {
    const pidFile = this.workerPidFilePath();
    if (!pidFile || !this.currentConfig) return;
    try {
      fs.mkdirSync(this.currentConfig.indexDir, { recursive: true });
      fs.writeFileSync(pidFile, `${pid}\n`, "utf-8");
    } catch {
      // Ignore pid file write issues.
    }
  }

  private clearWorkerPid(expectedPid?: number): void {
    const pidFile = this.workerPidFilePath();
    if (!pidFile || !fs.existsSync(pidFile)) return;
    try {
      if (expectedPid != null) {
        const raw = fs.readFileSync(pidFile, "utf-8").trim();
        const storedPid = Number.parseInt(raw, 10);
        if (!Number.isFinite(storedPid) || storedPid !== expectedPid) {
          return;
        }
      }
      fs.rmSync(pidFile, { force: true });
    } catch {
      // Ignore pid file cleanup issues.
    }
  }

  private readWorkerPid(): number | null {
    const pidFile = this.workerPidFilePath();
    if (!pidFile || !fs.existsSync(pidFile)) return null;
    try {
      const raw = fs.readFileSync(pidFile, "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      return pid;
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getProcessCommandLine(pid: number): string | null {
    if (process.platform === "linux") {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const normalized = cmdline.replace(/\u0000/g, " ").trim();
        return normalized || null;
      } catch {
        return null;
      }
    }

    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
      });
      if (result.status !== 0) return null;
      const output = (result.stdout || "").trim();
      return output || null;
    }

    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`;
      for (const shell of ["powershell", "pwsh"]) {
        const result = spawnSync(shell, ["-NoProfile", "-Command", script], {
          encoding: "utf-8",
        });
        if (result.status === 0) {
          const output = (result.stdout || "").trim();
          if (output) return output;
        }
      }
      return null;
    }

    return null;
  }

  private pidLooksLikeKnowledgeWorker(pid: number): boolean {
    const cmdline = this.getProcessCommandLine(pid);
    if (!cmdline) return false;
    return cmdline.includes("sync-worker.mjs");
  }

  private killStaleWorkerFromPidFile(): void {
    const stalePid = this.readWorkerPid();
    if (!stalePid) return;
    if (this.activeWorker?.pid === stalePid) return;

    if (!this.isPidAlive(stalePid)) {
      this.clearWorkerPid(stalePid);
      return;
    }

    if (!this.pidLooksLikeKnowledgeWorker(stalePid)) {
      this.clearWorkerPid(stalePid);
      return;
    }

    try {
      process.kill(stalePid, "SIGKILL");
    } catch {
      // Ignore stale-kill failures.
    } finally {
      this.clearWorkerPid(stalePid);
    }
  }

  private async stopActiveWorker(reason: string): Promise<void> {
    const worker = this.activeWorker;
    if (!worker) return;

    const pid = worker.pid;
    this.workerExitExpected = true;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        worker.removeListener("exit", onExit);
        resolve();
      };
      const onExit = () => finish();

      worker.once("exit", onExit);
      try {
        worker.kill("SIGTERM");
      } catch {
        finish();
        return;
      }

      const killTimer = setTimeout(() => {
        if (done) return;
        try {
          worker.kill("SIGKILL");
          console.warn(
            `knowledge-search: forced sync worker termination (${reason}, pid=${pid ?? "unknown"})`
          );
        } catch {
          // Ignore follow-up kill failures.
        }
        finish();
      }, this.WORKER_SHUTDOWN_GRACE_MS);
      killTimer.unref?.();
    });

    if (this.activeWorker?.pid === worker.pid) {
      this.activeWorker = null;
    }
    if (pid != null) {
      this.clearWorkerPid(pid);
    }
  }

  private createWorker(workerPath: string): ChildProcess {
    const env = { ...process.env };
    if (this.currentConfig) {
      env.KNOWLEDGE_SEARCH_RUNTIME_CONFIG = JSON.stringify(this.currentConfig);
    }
    try {
      env.KNOWLEDGE_SEARCH_CONFIG = getConfigPath();
    } catch {
      // Fall back to the worker's own config discovery if the parent has no active config path.
    }

    return fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
    });
  }

  private spawn(): void {
    this.killStaleWorkerFromPidFile();
    this.realtime?.stop();

    const workerPath = join(import.meta.dirname, "..", "dist", "sync-worker.mjs");
    const worker = this.createWorker(workerPath);

    this.syncDone = false;
    this.activeWorker = worker;

    if (worker.pid != null) {
      this.writeWorkerPid(worker.pid);
    }

    let stdout = "";
    worker.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    worker.on("message", (message: unknown) => {
      const payload = message as Partial<KnowledgeSearchProgressMessage>;
      if (payload?.type !== "knowledge-search-progress" || !payload.progress) {
        return;
      }
      this.statusBar.progress(payload.progress);
    });

    worker.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`knowledge-search worker: ${chunk.toString().trim()}`);
    });

    worker.on("error", (err) => {
      console.error(`knowledge-search: worker error: ${err.message}`);
    });

    worker.on("exit", (code, signal) => {
      this.syncDone = true;
      if (this.activeWorker?.pid === worker.pid) {
        this.activeWorker = null;
      }
      if (worker.pid != null) {
        this.clearWorkerPid(worker.pid);
      }

      if (code === 0 && stdout) {
        void Promise.resolve(this.handleWorkerSuccess(stdout));
        return;
      }

      if (code !== 0 && !this.workerExitExpected) {
        this.handleWorkerCrash(code, signal);
      }
    });
  }

  private async handleWorkerSuccess(stdout: string): Promise<void> {
    try {
      const result = JSON.parse(stdout) as SyncWorkerResult;
      await this.index?.load();
      this.statusBar.result(result);
      this.realtime?.start();
    } catch {
      // Ignore malformed worker output.
    }
  }

  private handleWorkerCrash(code: number | null, signal: NodeJS.Signals | null): void {
    const now = Date.now();
    if (now - this.workerRestartWindowStart > this.RESTART_WINDOW_MS) {
      this.workerRestartCount = 0;
      this.workerRestartWindowStart = now;
    }

    this.workerRestartCount += 1;

    if (this.workerRestartCount > this.MAX_WORKER_RESTARTS) {
      console.error(
        `knowledge-search: worker crashed ${this.workerRestartCount} times within ${this.RESTART_WINDOW_MS / 1000}s, giving up`
      );
      return;
    }

    console.error(
      `knowledge-search: worker exited unexpectedly (code=${code}, signal=${signal}), restarting (${this.workerRestartCount}/${this.MAX_WORKER_RESTARTS})...`
    );

    this.clearWorkerRestartTimer();
    this.workerRestartTimer = setTimeout(() => {
      this.workerRestartTimer = null;
      if (!this.workerExitExpected) {
        this.spawn();
      }
    }, 2000);
    this.workerRestartTimer.unref?.();
  }
}
