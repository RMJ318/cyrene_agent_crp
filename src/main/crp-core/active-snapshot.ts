import fs from "node:fs";
import path from "node:path";
import { CrpSnapshot } from "../memory-bridge/snapshot";
import { readBounded, safePath } from "../memory-bridge/safety";
import { createSnapshotQueryExecutor } from "./snapshot-query-adapter";
import type { GatewayExecutor } from "./query-gateway";

/** Optional hot source for the existing read-only MCP entry; OAuth and scopes stay host-issued. */
export function createActiveSnapshotExecutor(input: { directory?: string; fallback: CrpSnapshot; cursorKey: Buffer; repository: string; commit: string }): GatewayExecutor {
  let key = "fallback", executor = createSnapshotQueryExecutor(input.fallback, input.cursorKey, { repository: input.repository, commit: input.commit });
  return async (principal, request, signal) => {
    if (input.directory && fs.existsSync(path.join(input.directory, "active-main.json"))) {
      const pointer = JSON.parse(readBounded(safePath(input.directory, "active-main.json"), 8192).toString("utf8"));
      if (!/^[a-f0-9]{40}$/.test(pointer.commit) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(pointer.snapshotId)) throw Error("CRP_ACTIVE_SNAPSHOT_POINTER");
      const nextKey = pointer.commit + ":" + pointer.snapshotId;
      if (key !== nextKey) {
        const snapshot = new CrpSnapshot(safePath(path.join(input.directory, "snapshots"), pointer.snapshotId)); snapshot.validate();
        executor = createSnapshotQueryExecutor(snapshot, input.cursorKey, { repository: input.repository, commit: pointer.commit }); key = nextKey;
      }
    }
    return executor(principal, request, signal);
  };
}
