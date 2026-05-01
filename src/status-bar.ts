import type { Config, SyncProgress, SyncWorkerResult } from "./types.js";

export type { SyncProgress, SyncWorkerResult } from "./types.js";

export class StatusBar {
  private static instance: StatusBar | null = null;

  static shared(): StatusBar {
    if (!StatusBar.instance) {
      StatusBar.instance = new StatusBar();
    }
    return StatusBar.instance;
  }

  private ctx: any = null;
  private _config: Config | null = null;
  private progressState: SyncProgress | null = null;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private lastRenderTickMs: number | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatusText = "";
  private spinnerFrameIndex = 0;
  private percentFlashOn = true;
  private spinnerAccumulatorMs = 0;
  private flashAccumulatorMs = 0;

  private readonly THEME = {
    statusId: "knowledge-search",
    icon: {
      init: "⏳",
      done: "📕",
      active: "📖",
      spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    },
    label: {
      init: "KB init",
      done: "KB synced",
      paused: "KB paused",
      summary: "Index",
    },
  } as const;

  private readonly PERCENT_FLASH_INTERVAL_MS = 1000;
  private readonly SPINNER_FRAME_INTERVAL_MS = 100;
  private readonly STATUS_RENDER_INTERVAL_MS = 100;
  private readonly SUMMARY_CLEAR_DELAY_MS = 5000;

  private constructor() {}

  start(ctx: any, config: Config | null): void {
    this.ctx = ctx;
    this._config = config;
    this.lastStatusText = "";
    this.spinnerFrameIndex = 0;
    this.percentFlashOn = true;
    this.spinnerAccumulatorMs = 0;
    this.flashAccumulatorMs = 0;
    this.startRenderLoop();
  }

  stop(): void {
    this.stopRenderLoop();
    this.clearSummaryTimer();
    this.lastStatusText = "";
    this.progressState = null;
    this.spinnerFrameIndex = 0;
    this.percentFlashOn = true;
    this.spinnerAccumulatorMs = 0;
    this.flashAccumulatorMs = 0;
  }

  clear(): void {
    this.clearSummaryTimer();
    this.setStatus("");
  }

  pause(ctx?: any, config?: Config | null): void {
    if (ctx !== undefined) {
      this.ctx = ctx;
    }
    if (config !== undefined) {
      this._config = config;
    }

    this.stopRenderLoop();
    this.clearSummaryTimer();
    this.progressState = null;
    this.spinnerFrameIndex = 0;
    this.percentFlashOn = true;
    this.spinnerAccumulatorMs = 0;
    this.flashAccumulatorMs = 0;

    this.setStatus(`⏸ ${this.THEME.label.paused}`);
  }

  progress(progress: SyncProgress): void {
    this.progressState = progress;
    this.startRenderLoop();
    this.render(0, false);
  }

  result(result: SyncWorkerResult): void {
    const changes = result.added + result.updated + result.removed;
    if (changes <= 0) return;

    const deltaText = this.formatDelta(result.added, result.updated, result.removed);
    const deltaSuffix = deltaText.length > 0 ? ` (${deltaText})` : "";

    this.setStatus(
      `${this.THEME.label.summary}:${deltaSuffix} (${result.size} files, ${result.chunks} chunks)`
    );

    this.clearSummaryTimer();
    this.clearTimer = setTimeout(() => {
      this.setStatus("");
      this.clearTimer = null;
    }, this.SUMMARY_CLEAR_DELAY_MS);
    this.clearTimer.unref?.();
  }

  mode(): "cli" | "tui" | "rpc" {
    const argMode = process.argv.find((arg) => arg.startsWith("--mode="));
    if (argMode === "--mode=cli") return "cli";
    if (argMode === "--mode=tui") return "tui";
    if (argMode === "--mode=rpc") return "rpc";

    const modeIndex = process.argv.findIndex((arg) => arg === "--mode");
    if (modeIndex >= 0) {
      const mode = process.argv[modeIndex + 1];
      if (mode === "cli" || mode === "tui" || mode === "rpc") {
        return mode;
      }
    }

    if (typeof this.ctx?.ui?.setStatus === "function") return "tui";
    if (typeof process.send === "function") return "rpc";
    return "cli";
  }

  render(deltaTimeMs = this.STATUS_RENDER_INTERVAL_MS, advance = true): void {
    const progress = this.progressState;
    if (!progress) return;

    const mode = this.mode();
    if (mode === "cli") return;
    if (typeof this.ctx?.ui?.setStatus !== "function") return;

    if (advance) {
      this.advanceAnimation(deltaTimeMs, progress.phase);
    }

    const statusIcon =
      progress.phase === "init"
        ? this.THEME.icon.init
        : progress.phase === "done"
          ? this.THEME.icon.done
          : progress.phase === "upsert"
            ? this.THEME.icon.spinner[this.spinnerFrameIndex % this.THEME.icon.spinner.length]
            : this.THEME.icon.active;

    if (progress.phase === "done") {
      this.spinnerFrameIndex = 0;
      this.percentFlashOn = true;
      this.spinnerAccumulatorMs = 0;
      this.flashAccumulatorMs = 0;
      this.stopRenderLoop();
    }

    const total = Math.max(progress.total, 0);
    const processed = Math.max(Math.min(progress.processed, total || progress.processed), 0);
    const percent =
      progress.phase === "done"
        ? 100
        : total > 0
          ? Math.min(Math.max((processed / total) * 100, 0), 100)
          : 0;
    const baseProgressText = `${percent.toFixed(2)}%`;
    const showPercent = progress.phase === "upsert";
    const progressText =
      progress.phase === "done" || progress.phase === "init" || !showPercent ? "" : baseProgressText;
    const deltaText = this.formatDelta(progress.added, progress.updated, progress.removed);
    const detailText = (progress.detail ?? "").trim();
    const detailSuffix = detailText.length > 0 ? ` - ${detailText.slice(0, 140)}` : "";
    const deltaSuffix = deltaText.length > 0 ? ` (${deltaText})` : "";
    const doneSuffix =
      progress.phase === "done"
        ? this.THEME.label.done
        : progress.phase === "init"
          ? this.THEME.label.init
          : "";

    this.setStatus(
      `${statusIcon}${progressText ? ` ${progressText}` : ""}${doneSuffix ? ` ${doneSuffix}` : ""}${deltaSuffix}${detailSuffix}`
    );
  }

  private advanceAnimation(deltaTimeMs: number, phase: SyncProgress["phase"]): void {
    if (!Number.isFinite(deltaTimeMs) || deltaTimeMs <= 0) return;

    if (phase === "upsert") {
      this.spinnerAccumulatorMs += deltaTimeMs;
      const spinnerSteps = Math.floor(this.spinnerAccumulatorMs / this.SPINNER_FRAME_INTERVAL_MS);
      if (spinnerSteps > 0) {
        this.spinnerFrameIndex =
          (this.spinnerFrameIndex + spinnerSteps) % this.THEME.icon.spinner.length;
        this.spinnerAccumulatorMs -= spinnerSteps * this.SPINNER_FRAME_INTERVAL_MS;
      }
    }

    if (phase !== "init") {
      this.flashAccumulatorMs += deltaTimeMs;
      const flashSteps = Math.floor(this.flashAccumulatorMs / this.PERCENT_FLASH_INTERVAL_MS);
      if (flashSteps > 0) {
        if (flashSteps % 2 === 1) {
          this.percentFlashOn = !this.percentFlashOn;
        }
        this.flashAccumulatorMs -= flashSteps * this.PERCENT_FLASH_INTERVAL_MS;
      }
    }
  }

  private formatDelta(added: number, updated: number, removed: number): string {
    const parts: string[] = [];
    if (added > 0) {
      parts.push(`+${added}`);
    }
    if (updated > 0) {
      parts.push(`~${updated}`);
    }
    if (removed > 0) {
      parts.push(`-${removed}`);
    }
    return parts.join(" ");
  }

  private startRenderLoop(): void {
    if (this.renderTimer) return;
    this.lastRenderTickMs = Date.now();
    this.renderTimer = setInterval(() => {
      const nowMs = Date.now();
      const previousMs = this.lastRenderTickMs ?? nowMs;
      this.lastRenderTickMs = nowMs;
      const deltaTimeMs = Math.max(nowMs - previousMs, 0);
      this.render(deltaTimeMs);
    }, this.STATUS_RENDER_INTERVAL_MS);
    this.renderTimer.unref?.();
  }

  private stopRenderLoop(): void {
    if (!this.renderTimer) return;
    clearInterval(this.renderTimer);
    this.renderTimer = null;
    this.lastRenderTickMs = null;
  }

  private clearSummaryTimer(): void {
    if (!this.clearTimer) return;
    clearTimeout(this.clearTimer);
    this.clearTimer = null;
  }

  private setStatus(text: string): void {
    if (text === this.lastStatusText) return;
    this.lastStatusText = text;
    try {
      this.ctx?.ui?.setStatus?.(this.THEME.statusId, text);
    } catch {
      // Ignore UI status transport failures.
    }
  }
}
