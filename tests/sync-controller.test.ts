import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SyncController } from "../src/sync-controller.js";
import { FileWatcher } from "../src/watcher.js";
import { makeTestConfig } from "./helpers/index-fixtures.js";

function resetSharedController(): any {
  (SyncController as any).instance = null;
  const controller = SyncController.shared() as any;
  controller.statusBar = {
    start() {},
    progress() {},
    pause() {},
    clear() {},
    stop() {},
    result() {},
  };
  controller.clearWorkerRestartTimer = () => {};
  controller.killStaleWorkerFromPidFile = () => {};
  controller.clearWorkerPid = () => {};
  controller.activeWorker = null;
  controller.currentConfig = null;
  controller.index = null;
  controller.realtime = null;
  controller.ctx = null;
  controller.syncDone = true;
  controller.workerExitExpected = false;
  controller.workerRestartCount = 0;
  controller.workerRestartTimer = null;
  return controller;
}

describe("SyncController watcher lifecycle", () => {
  let controller: any;

  beforeEach(() => {
    controller = resetSharedController();
  });

  it("keeps the watcher stopped until the worker reports success", async () => {
    const calls: string[] = [];
    const realtime = {
      start() {
        calls.push("watcher:start");
      },
      stop() {
        calls.push("watcher:stop");
      },
    };
    const index = {
      async load() {
        calls.push("index:load");
      },
      reindex() {
        return "running";
      },
    };

    controller.stopActiveWorker = async (reason: string) => {
      calls.push(`worker:stop:${reason}`);
    };
    controller.spawn = () => {
      calls.push("worker:spawn");
      controller.syncDone = false;
    };

    await controller.start({
      config: makeTestConfig("/tmp/index", {
        dirs: ["/tmp/docs"],
        fileExtensions: [".md", ".txt"],
        excludeDirs: ["node_modules"],
      }),
      index,
      ctx: {},
      realtime,
    });

    assert.deepStrictEqual(calls, ["worker:stop:session_start", "watcher:stop", "worker:spawn"]);

    await controller.handleWorkerSuccess(
      JSON.stringify({ added: 1, updated: 0, removed: 0, size: 2, chunks: 3 })
    );

    assert.deepStrictEqual(calls, [
      "worker:stop:session_start",
      "watcher:stop",
      "worker:spawn",
      "index:load",
      "watcher:start",
    ]);
  });

  it("stops the watcher during restart, pause, and stop", async () => {
    const calls: string[] = [];
    const realtime = {
      start() {
        calls.push("watcher:start");
      },
      stop() {
        calls.push("watcher:stop");
      },
    };
    const index = {
      async load() {},
      async reset() {
        calls.push("index:reset");
      },
      reindex(state?: string) {
        if (state) {
          calls.push(`index:state:${state}`);
          return;
        }

        return "running";
      },
    };

    controller.stopActiveWorker = async (reason: string) => {
      calls.push(`worker:stop:${reason}`);
    };
    controller.spawn = () => {
      calls.push("worker:spawn");
      controller.syncDone = false;
    };

    await controller.restart({
      config: makeTestConfig("/tmp/index", {
        dirs: ["/tmp/docs"],
        fileExtensions: [".md", ".txt"],
        excludeDirs: ["node_modules"],
      }),
      index,
      ctx: {},
      realtime,
    });
    assert.deepStrictEqual(calls, [
      "watcher:stop",
      "index:state:running",
      "index:reset",
      "worker:stop:session_start",
      "watcher:stop",
      "worker:spawn",
    ]);

    calls.length = 0;
    controller.realtime = realtime;
    controller.index = index;
    controller.currentConfig = makeTestConfig("/tmp/index", {
      dirs: ["/tmp/docs"],
      fileExtensions: [".md", ".txt"],
      excludeDirs: ["node_modules"],
    });
    controller.syncDone = false;
    await controller.pause({});
    assert.deepStrictEqual(calls, [
      "watcher:stop",
      "worker:stop:reindex_pause",
      "index:state:paused",
    ]);

    calls.length = 0;
    controller.realtime = realtime;
    controller.index = index;
    controller.currentConfig = makeTestConfig("/tmp/index", {
      dirs: ["/tmp/docs"],
      fileExtensions: [".md", ".txt"],
      excludeDirs: ["node_modules"],
    });
    controller.syncDone = false;
    await controller.stop();
    assert.deepStrictEqual(calls, [
      "watcher:stop",
      "worker:stop:session_shutdown",
      "index:state:paused",
    ]);
  });
});

describe("FileWatcher", () => {
  it("starts each directory once and closes all watchers on stop", () => {
    const created: string[] = [];
    const closed: string[] = [];

    const watcher = new FileWatcher(
      makeTestConfig("/tmp/index", {
        dirs: ["/tmp/docs-a", "/tmp/docs-b"],
        fileExtensions: [".md", ".txt"],
        excludeDirs: ["node_modules"],
      }),
      {
        ingest: async () => {},
        remove: () => {},
      } as any,
      (watchPath, _options, _listener) => {
        created.push(watchPath);
        return {
          on() {
            return this;
          },
          close() {
            closed.push(watchPath);
          },
        } as any;
      }
    );

    watcher.start();
    watcher.start();
    watcher.stop();

    assert.deepStrictEqual(created, ["/tmp/docs-a", "/tmp/docs-b"]);
    assert.deepStrictEqual(closed, ["/tmp/docs-a", "/tmp/docs-b"]);
  });
});