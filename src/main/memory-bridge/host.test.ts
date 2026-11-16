import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_BRIDGE_IPC } from "../../shared/memory-bridge";
import { bridgePolicy } from "./policy";
import { MemoryBridgeService, setMemoryBridgeRuntime } from "./service";
import { registerMemoryBridgeIpc } from "./host";
import { register } from "../../plugins/crp-memory-bridge";
import { executeToolDefinition } from "../orchestrator/tools/registry/tool-executor";
import { createPluginConversationsService } from "../plugin-host/conversations-service";

const mock = vi.hoisted(() => ({ exposed: new Map<string, any>(), handlers: new Map<string, any>(), sender: { id: 7, mainFrame: {} }, dialog: vi.fn() }));
vi.mock("electron", () => ({
  app: {}, safeStorage: {}, dialog: { showOpenDialog: mock.dialog },
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => mock.exposed.set(name, value) },
  ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => mock.handlers.get(channel)({ sender: mock.sender, senderFrame: mock.sender.mainFrame }, ...args) },
}));
vi.mock("../settings/model-settings", () => ({ loadModelSettings: () => ({}), resolveSessionModelSettings: () => ({ model: "mock-local", baseUrl: "http://localhost:9999" }) }));
vi.mock("../chats/chats-store", () => ({ getSessionRecord: async () => ({ id: "writer-chat" }) }));

let root: string, service: MemoryBridgeService;
const disposals: Array<() => void> = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-bridge-host-"));
  service = new MemoryBridgeService(root, { available: () => false, encrypt: () => { throw new Error("unavailable"); }, decrypt: () => { throw new Error("unavailable"); } });
  setMemoryBridgeRuntime(service); mock.handlers.clear(); mock.exposed.clear(); mock.dialog.mockReset();
});
afterEach(() => { for (const d of disposals.splice(0)) d(); service.close(); fs.rmSync(root, { recursive: true, force: true }); });

function registerPlugin() {
  const tools: any[] = [], providers: any[] = [];
  register({ registerTool: (t: any) => tools.push(t), registerPromptProvider: (p: any) => providers.push(p), onDispose: (d: () => void) => disposals.push(d) } as any);
  service.setEnabled(true);
  return { tools, providers };
}

describe("real preload → host IPC → isolated store", () => {
  it("only a trusted top-level renderer can save, manage or release records", async () => {
    registerMemoryBridgeIpc({ ipc: { handle: (name, handler) => mock.handlers.set(name, handler) } as any,
      trustedSender: id => id === 7, createSession: async () => ({ id: "writer-chat" }), openSession: async () => {} });
    await import("../../preload/index");
    const api = mock.exposed.get("memoryBridge");
    expect(api).toBeDefined();
    expect(await api.request("new-session", { scope: { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" } })).toMatchObject({ ok: false, error: "BRIDGE_USER_CONFIRMATION_REQUIRED" });
    expect(await api.request("new-session", { scope: { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" }, confirmed: true })).toMatchObject({ ok: true });
    expect(await api.request("create", { domain: "writer", record: { content: "fictional project", sensitive: false, participants: [] }, confirmed: true })).toMatchObject({ ok: true, value: { revision: 1 } });
    expect((await api.request("list", { domain: "writer" })).value).toHaveLength(1);
    const handler = mock.handlers.get(MEMORY_BRIDGE_IPC);
    await expect(handler({ sender: { id: 9 }, senderFrame: {} }, "list", { domain: "writer" })).rejects.toThrow("UNTRUSTED_SENDER");
    await expect(handler({ sender: mock.sender, senderFrame: {} }, "list", { domain: "writer" })).rejects.toThrow("UNTRUSTED_SENDER");
    expect(await api.request("model-target", { sessionId: "writer-chat" })).toMatchObject({ value: { display: "mock-local · http://localhost:9999" } });
    expect(await api.request("delete", { domain: "rp", id: "anything", confirmed: true })).toMatchObject({ ok: false, error: "BRIDGE_LOCAL_DOMAIN_REQUIRED" });
  });
});

describe("registered read tools and direct execution boundary", () => {
  it("ordinary selected-reality tools require a desktop run and the host fingerprint", async () => {
    const { tools } = registerPlugin(); service.setRetrievalV3(true); bridgePolicy.setRecall("normal", ["42"]);
    const query = vi.spyOn(service, "queryAsync").mockResolvedValue({ status: "unknown", memories: [], gaps: [] });
    try {
      const search = tools.find(t => t.name === "search_memories"), context = { conversationId: "normal", runId: "r", userQuery: "test", metadata: { memoryBridgeOrigin: "desktop", memoryBridgeFingerprint: service.fingerprint("normal") } };
      expect((await executeToolDefinition(search, { query: "test" }, context)).status).toBe("succeeded");
      query.mockClear();
      expect((await executeToolDefinition(search, { query: "test" }, { ...context, channelRun: true })).status).toBe("failed");
      expect((await executeToolDefinition(search, { query: "test" }, { ...context, metadata: {} })).status).toBe("failed");
      expect(query).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
  });
  it("tool arguments cannot change domain; consent is run-bound and disable cancels live requests", async () => {
    const { tools, providers } = registerPlugin();
    service.bindNew("writer-chat", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" });
    const record = service.manage("create", { domain: "writer", record: { content: "fictional telescope project", sensitive: false, participants: [] }, confirmed: true }) as any;
    service.manage("grant", { domain: "writer", id: record.id, revision: 1, sessionId: "writer-chat", confirmed: true });
    const context = { conversationId: "writer-chat", runId: "run-one", userQuery: "project", metadata: { memoryBridgeOrigin: "desktop", memoryBridgeFingerprint: service.fingerprint("writer-chat") } };
    const search = tools.find(t => t.name === "search_memories");
    const result = await executeToolDefinition(search, { query: "project", domain: "rp", realityId: "42" }, context);
    expect(result.output).toContain("fictional telescope project"); expect(result.output).toContain('"domain":"writer"');
    const next = await executeToolDefinition(search, { query: "project" }, { ...context, runId: "run-two" });
    expect(next.output).not.toContain("fictional telescope project");
    expect((await executeToolDefinition(search, { query: "project" }, { ...context, metadata: {} })).status).toBe("failed");
    expect((await executeToolDefinition(search, { query: "project" }, { ...context, channelRun: true })).status).toBe("failed");
    const unsafe = { id: "wiki_search", execute: vi.fn(async () => "legacy private record") };
    expect((await executeToolDefinition(unsafe as any, {}, context)).status).toBe("failed"); expect(unsafe.execute).not.toHaveBeenCalled();
    expect(providers[0].provide({ source: "conversation", conversationId: "writer-chat", channel: "qq" })).toBe("");
    const active = service.signal; service.setPluginActive(false); expect(active.aborted).toBe(true);
    expect((await executeToolDefinition(search, { query: "project" }, context)).status).toBe("failed");
    expect(bridgePolicy.protects("writer-chat")).toBe(true);
  });
  it("personal disclosure and revoked consent start a fresh model segment without deleting UI history", () => {
    registerPlugin(); service.bindNew("writer-chat", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" });
    expect(service.contextFloor("writer-chat", "run-1", 10)).toBe(10);
    expect(service.contextFloor("writer-chat", "run-2", 20)).toBe(10);
    const r = service.manage("create", { domain: "writer", record: { content: "project", sensitive: false, participants: [] }, confirmed: true }) as any;
    service.manage("grant", { domain: "writer", id: r.id, revision: 1, sessionId: "writer-chat", confirmed: true });
    expect(service.contextFloor("writer-chat", "run-3", 30)).toBe(30);
    service.query({ sessionId: "writer-chat", runId: "run-3", origin: "desktop", query: "project" });
    expect(service.contextFloor("writer-chat", "run-4", 40)).toBe(40);
    service.manage("revoke", { domain: "writer", id: r.id, confirmed: true });
    expect(service.contextFloor("writer-chat", "run-5", 50)).toBe(50);
  });
  it("other plugins cannot list or read protected conversation history", async () => {
    registerPlugin(); service.bindNew("protected", { domain: "writer", realityId: "-1", branchId: null, audience: "archive-reference" });
    const reader = { listSessions: async () => [{ id: "protected", title: "secret", mode: "chat", createdAt: 0, updatedAt: 0 }, { id: "ordinary", title: "ordinary", mode: "chat", createdAt: 0, updatedAt: 0 }], getSession: vi.fn(async () => ({ messages: [] })) };
    const conversations = createPluginConversationsService({ reader: reader as any });
    expect((await conversations.list({})).items.map(i => i.id)).toEqual(["ordinary"]);
    await expect(conversations.getMessages({ conversationId: "protected" })).rejects.toThrow("会话不可用于插件历史读取");
    expect(reader.getSession).not.toHaveBeenCalled();
  });
});
