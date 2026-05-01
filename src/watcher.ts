import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, WatchFactory } from "./types.js";
import type { KnowledgeIndex } from "./index-store.js";

/**
 * Watches configured directories for file changes and updates the local index in real time.
 *
 * The watcher only runs after the background sync worker has completed so live
 * updates do not race the initial rebuild.
 */
export class FileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs = 300;

  /**
   * Bind the watcher to the active local index and runtime config.
   *
   * The KnowledgeIndex instance owns the actual adapter-backed update logic; the
   * watcher only decides when to call it for a changed or deleted path.
   */
  constructor(
    private readonly config: Config,
    private readonly index: KnowledgeIndex,
    private readonly createWatch: WatchFactory = fs.watch
  ) {}

  start(): void {
    if (this.watchers.length > 0) {
      return;
    }

    for (const dir of this.config.dirs) {
      try {
        const watcher = this.createWatch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;

          const relPath =
            (typeof filename === "string" ? filename : filename.toString("utf-8")).replace(
              /\\/g,
              "/"
            );
          if (!this.config.fileExtensions.includes(path.extname(relPath))) {
            return;
          }

          const parts = relPath.split("/");
          for (const part of parts) {
            if (this.config.excludeDirs.includes(part) || part.startsWith(".")) {
              return;
            }
          }

          this.debounce(path.join(dir, relPath), dir);
        });

        watcher.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EACCES" || err.code === "ENOENT") {
            return;
          }
          console.error(`knowledge-search: watcher error for ${dir}: ${err.message}`);
        });

        this.watchers.push(watcher);
      } catch (err: any) {
        console.error(`knowledge-search: watcher failed for ${dir}: ${err.message}`);
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private debounce(absPath: string, sourceDir: string): void {
    const existing = this.pending.get(absPath);
    if (existing) {
      clearTimeout(existing);
    }

    this.pending.set(
      absPath,
      setTimeout(async () => {
        this.pending.delete(absPath);
        try {
          if (fs.existsSync(absPath)) {
            await this.index.ingest(absPath, sourceDir);
          } else {
            this.index.remove(absPath);
          }
        } catch (err: any) {
          console.error(`knowledge-search: watcher update failed for ${absPath}: ${err.message}`);
        }
      }, this.debounceMs)
    );
  }
}
