import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneralSettings } from "./general-settings";
import type { McpServerConfig } from "../orchestrator/mcp-adapter";

const mocks = vi.hoisted(() => ({
  configs: [] as McpServerConfig[], states: [] as Array<{ id: string; connected: boolean }>,
  add: vi.fn(), remove: vi.fn(),
}));
vi.mock("electron", () => ({ app: {}, nativeImage: {} }));
vi.mock("../windows/window-state", () => ({ setGetCurrentAppIconPath: vi.fn() }));
vi.mock("../locale-context", () => ({ updateLocaleContext: vi.fn() }));
vi.mock("../orchestrator/mcp-manager", () => ({
  addMcpServer: mocks.add, removeMcpServer: mocks.remove,
  listMcpServers: () => mocks.states, listMcpServerConfigs: () => mocks.configs,
}));
vi.mock("../app-icon", () => ({ getAppIconPath: vi.fn() }));
vi.mock("../orchestrator/tools/registry/tool-registration", () => ({ syncBuiltInToolToggles: vi.fn() }));
vi.mock("./model-settings", () => ({ loadModelSettings: vi.fn(), getPublicModelConfig: vi.fn() }));
vi.mock("./launch-at-login", () => ({ syncLaunchAtLogin: vi.fn() }));
vi.mock("../system-ui-theme", () => ({ getEffectiveUiTheme: vi.fn() }));
import { syncVolcanoSearchMcp } from "./general-settings-lifecycle";

const serverId = "minimax-web-search";
const settings = (key = "test-key", engine = "minimax") => ({ searchEngine: engine, searchMinimaxKey: key }) as GeneralSettings;
function config(key = "test-key"): McpServerConfig {
  return { id: serverId, name: "MiniMax搜索", transport: "stdio", command: "uvx", args: ["minimax-coding-plan-mcp", "-y"], env: { MINIMAX_API_KEY: key, MINIMAX_API_HOST: "https://api.minimaxi.com" } };
}
function install(cfg: McpServerConfig) {
  mocks.configs.push(cfg);
  mocks.states.push({ id: cfg.id, connected: true });
  return { ok: true, toolIds: [serverId + "-web_search"] };
}
beforeEach(() => {
  mocks.configs = []; mocks.states = [];
  mocks.add.mockReset().mockImplementation(async (cfg: McpServerConfig) => install(cfg));
  mocks.remove.mockReset().mockImplementation(async (id: string) => {
    mocks.configs = mocks.configs.filter(cfg => cfg.id !== id);
    mocks.states = mocks.states.filter(state => state.id !== id);
    return { ok: true };
  });
});

describe("MiniMax 搜索 MCP 同步", () => {
  it("保存无关设置不重建健康连接", async () => {
    install(config());
    await expect(syncVolcanoSearchMcp(settings())).resolves.toEqual({ mcpSyncResult: "no_change" });
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("失败的持久化配置仍可清理并重连", async () => {
    mocks.configs.push(config());
    await expect(syncVolcanoSearchMcp(settings())).resolves.toEqual({ mcpSyncResult: "reregistered" });
    expect(mocks.remove).toHaveBeenCalledWith(serverId);
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.states[0].connected).toBe(true);
  });
  it("关闭搜索时也移除没有运行态的残留配置", async () => {
    mocks.configs.push(config());
    await expect(syncVolcanoSearchMcp(settings("", "off"))).resolves.toEqual({ mcpSyncResult: "removed" });
    expect(mocks.configs).toEqual([]);
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("更新 key 后注册失败不会误报重建成功", async () => {
    install(config("old-key"));
    mocks.add.mockResolvedValueOnce({ ok: false, error: "PRIVATE_KEY" });
    await expect(syncVolcanoSearchMcp(settings("new-key"))).resolves.toEqual({ mcpSyncResult: "register_failed" });
    expect(mocks.configs).toEqual([]);
  });
  it("并发的重复同步只创建一个连接", async () => {
    const results = await Promise.all([syncVolcanoSearchMcp(settings()), syncVolcanoSearchMcp(settings())]);
    expect(results.map(r => r.mcpSyncResult)).toEqual(["registered", "no_change"]);
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("快速更新配置后保留最后一次的 key", async () => {
    await Promise.all([syncVolcanoSearchMcp(settings("first")), syncVolcanoSearchMcp(settings("second"))]);
    expect(mocks.configs).toHaveLength(1);
    expect(mocks.configs[0].env?.MINIMAX_API_KEY).toBe("second");
  });
  it("连接中关闭搜索不会留下迟到连接", async () => {
    let release!: () => void;
    mocks.add.mockImplementationOnce(async (cfg: McpServerConfig) => {
      await new Promise<void>(resolve => { release = resolve; });
      return install(cfg);
    });
    const first = syncVolcanoSearchMcp(settings());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const disabled = syncVolcanoSearchMcp(settings("", "off"));
    release();
    await Promise.all([first, disabled]);
    expect(mocks.configs).toEqual([]);
    expect(mocks.states).toEqual([]);
  });
  it("无效 key 不连接，异常诊断不带原始错误文本", async () => {
    await expect(syncVolcanoSearchMcp(settings("非法key"))).resolves.toEqual({ mcpSyncResult: "key_invalid" });
    expect(mocks.add).not.toHaveBeenCalled();
    mocks.add.mockRejectedValueOnce(new Error("PRIVATE_KEY"));
    await expect(syncVolcanoSearchMcp(settings())).resolves.toEqual({ mcpSyncResult: "sync_exception" });
    await expect(syncVolcanoSearchMcp(settings())).resolves.toEqual({ mcpSyncResult: "registered" });
  });
});
