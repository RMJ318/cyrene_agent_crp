import { app, dialog, safeStorage } from "electron";
import path from "node:path";
import type { IpcScope } from "../application/ipc-scope";
import { MEMORY_BRIDGE_IPC } from "../../shared/memory-bridge";
import { MemoryBridgeService, getMemoryBridgeRuntime, setMemoryBridgeRuntime } from "./service";
import { fail, modelConsentTarget, validateScope } from "./safety";
import { loadModelSettings, resolveSessionModelSettings } from "../settings/model-settings";
import * as chatsStore from "../chats/chats-store";
import { createLocalEmbeddingProvider } from "../rag/embedding";
import { CrpSyncClient, loadSyncClientConfig } from "../crp-sync/client";
import { collectMemoryFiles } from "../crp-sync/collector";

export function initializeMemoryBridge(forbiddenRoots: () => string[]): MemoryBridgeService {
  const service = new MemoryBridgeService(path.join(app.getPath("userData"), "crp-memory-bridge"), {
    available: () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== "basic_text",
    encrypt: text => safeStorage.encryptString(text).toString("base64"),
    decrypt: cipher => safeStorage.decryptString(Buffer.from(cipher, "base64")),
  }, undefined, forbiddenRoots, () => createLocalEmbeddingProvider("bgem3", { persistentIdentity: true }));
  setMemoryBridgeRuntime(service);
  try {
    const userData = app.getPath("userData"), config = loadSyncClientConfig(userData);
    if (config) {
      const client = new CrpSyncClient(userData, config, {
        adopt: (source, provenance, signal) => service.import(source, signal, false, provenance),
        collect: async () => collectMemoryFiles(userData, (await chatsStore.listSessions()).map(s => s.workspaceRoot).filter((p): p is string => typeof p === "string" && !!p)),
      });
      service.setSynchronization(client); client.start();
    }
  } catch {
    service.setSynchronization({ status: () => ({ lastError: "SYNC_CONFIG_OR_START_FAILED" }), tick: async () => undefined, close: async () => undefined });
  }
  return service;
}
export function registerMemoryBridgeIpc(input: {
  ipc: IpcScope; trustedSender(id: number): boolean;
  createSession(title: string): Promise<{ id: string }>;
  openSession(id: string): Promise<void>;
}): void {
  input.ipc.handle(MEMORY_BRIDGE_IPC, async (event, command: unknown, raw: unknown = {}) => {
    // Plugin frames, web pages and other renderer processes cannot administer private memory.
    if (!event?.sender || !input.trustedSender(event.sender.id) || event.senderFrame !== event.sender.mainFrame) fail("UNTRUSTED_SENDER");
    try {
      if (typeof command !== "string" || !raw || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST");
      const args = raw as Record<string, unknown>;
      const service = getMemoryBridgeRuntime();
      switch (command) {
        case "recall-state":
        case "set-recall": {
          if (args.sessionId !== undefined && typeof args.sessionId !== "string") fail("INVALID_REQUEST");
          const id = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : undefined;
          if (id && !await chatsStore.getSessionRecord(id)) fail("UNKNOWN_SESSION");
          return { ok: true, value: command === "set-recall" ? service.setRecallRealities(id, args.realities) : service.recallState(id) };
        }
        case "status": return { ok: true, value: service.status() };
        case "sync-now": return { ok: true, value: await service.synchronizeNow() };
        case "model-target": {
          service.policy.scope(String(args.sessionId));
          const session = await chatsStore.getSessionRecord(String(args.sessionId));
          if (!session) fail("UNKNOWN_SESSION");
          const settings = resolveSessionModelSettings(loadModelSettings(), session);
          let origin = "未知服务地址";
          try { origin = new URL(settings.baseUrl).origin; } catch { /* no secrets in error output */ }
          return { ok: true, value: { display: `${settings.model} · ${origin}`, token: modelConsentTarget(settings) } };
        }
        case "grant": {
          const session = await chatsStore.getSessionRecord(String(args.sessionId));
          if (!session) fail("UNKNOWN_SESSION");
          const settings = resolveSessionModelSettings(loadModelSettings(), session);
          if (args.expectedModelTarget !== modelConsentTarget(settings)) fail("MODEL_TARGET_CHANGED");
          return { ok: true, value: service.manage("grant", { ...args, modelTarget: modelConsentTarget(settings) }) };
        }
        case "preview": return { ok: true, value: await service.previewAsync(args.scope, String(args.query ?? "")) };
        case "continuity-files": return { ok: true, value: service.continuityFiles() };
        case "map-continuity": return { ok: true, value: service.mapContinuity(args) };
        case "unmap-continuity": service.unmapContinuity(String(args.id), args.confirmed === true); return { ok: true };
        case "enable": service.setEnabled(args.enabled === true); return { ok: true, value: service.status() };
        case "local-semantic": service.setLocalSemantic(args.enabled === true); return { ok: true, value: service.status() };
        case "retrieval-v3": service.setRetrievalV3(args.enabled === true); return { ok: true, value: service.status() };
        case "cancel": service.cancel(); return { ok: true };
        case "import-github": {
          if (typeof args.repository !== "string") fail("INVALID_GITHUB_REPOSITORY");
          return { ok: true, value: await service.import(args.repository, undefined, true) };
        }
        case "import": {
          const picked = await dialog.showOpenDialog({ title: "选择 CRP 本地只读来源", properties: ["openDirectory"] });
          if (picked.canceled || !picked.filePaths[0]) return { ok: true, cancelled: true };
          return { ok: true, value: await service.import(picked.filePaths[0]) };
        }
        case "rollback": service.rollback(); return { ok: true, value: service.status() };
        case "new-session": {
          if (args.confirmed !== true) fail("USER_CONFIRMATION_REQUIRED");
          const scope = validateScope(args.scope);
          const session = await input.createSession(`Memory Bridge · ${scope.domain} · #${scope.realityId}`);
          service.bindNew(session.id, scope);
          await input.openSession(session.id);
          return { ok: true, value: session.id };
        }
        case "open-session": service.policy.scope(String(args.sessionId)); await input.openSession(String(args.sessionId)); return { ok: true };
        case "deactivate": service.deactivate(String(args.sessionId)); return { ok: true };
        default: return { ok: true, value: service.manage(command, args) };
      }
    } catch (error) {
      // Never forward filesystem paths, SQL diagnostics, keys or record contents to logs/UI errors.
      const code = error instanceof Error && /^BRIDGE_[A-Z_]+$/.test(error.message) ? error.message : "BRIDGE_OPERATION_FAILED";
      return { ok: false, error: code };
    }
  });
}
