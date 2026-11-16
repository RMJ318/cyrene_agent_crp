import { app, nativeImage, type Tray } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { WindowManager } from "../windows/window-manager";
import { setGetCurrentAppIconPath } from "../windows/window-state";
import { updateLocaleContext } from "../locale-context";
import { validateSearchApiKey } from "../orchestrator/search-backend-filter";
import { addMcpServer, listMcpServers, listMcpServerConfigs, removeMcpServer } from "../orchestrator/mcp-manager";
import { getAppIconPath } from "../app-icon";
import { syncBuiltInToolToggles } from "../orchestrator/tools/registry/tool-registration";
import { loadModelSettings, getPublicModelConfig } from "./model-settings";
import type { GeneralSettings } from "./general-settings";
import type { UiIcon } from "../../shared/ui-icon";
import { syncLaunchAtLogin } from "./launch-at-login";
import { hasCurrentDisclaimerConsent } from "../../shared/disclaimer";
import { getEffectiveUiTheme } from "../system-ui-theme";

export interface GeneralSettingsLifecycleDependencies {
  get windowManager(): WindowManager | null;
  get tray(): Tray | null;
  get screenshotService(): { replaceHotkey: (hotkey: string) => { ok: boolean } | null } | null;
  get proactiveLifecycle(): { getProactiveChatService: () => { invalidate: () => void } | null };
  broadcastToAuxWindows(channel: string, payload: unknown): void;
}

/** MiniMax 搜索 MCP Server 的固定 ID。 */
const MINIMAX_SEARCH_MCP_ID = "minimax-web-search";

export function applyGeneralSettings(
  settings: GeneralSettings,
  deps: GeneralSettingsLifecycleDependencies,
  before?: GeneralSettings,
): void {
  // 启动时完整应用；保存设置时只应用变化项，保留托盘临时隐藏等窗口状态。
  if (!before || before.petAlwaysOnTop !== settings.petAlwaysOnTop) {
    deps.windowManager?.setPetWindowAlwaysOnTop(settings.petAlwaysOnTop);
  }
  const disclaimerAccepted = hasCurrentDisclaimerConsent(settings.disclaimerAcceptedVersion);
  const disclaimerAcceptanceChanged = before?.disclaimerAcceptedVersion !== settings.disclaimerAcceptedVersion;
  if (!disclaimerAccepted) {
    deps.windowManager?.hidePetWindow();
  } else if (!before || before.petVisible !== settings.petVisible || disclaimerAcceptanceChanged) {
    if (settings.petVisible) deps.windowManager?.showPetWindow();
    else deps.windowManager?.hidePetWindow();
  }
  const wasDisclaimerAccepted = !before || hasCurrentDisclaimerConsent(before.disclaimerAcceptedVersion);
  if (!wasDisclaimerAccepted && disclaimerAccepted) {
    setTimeout(() => {
      deps.windowManager?.closeOnboardingWindow?.();
      void deps.windowManager?.openReactChatWindow().catch((error) => {
        console.error("[Cyrene] failed to open workspace after disclaimer acceptance:", error);
      });
    }, 0);
  }
  if (!before || before.launchAtLogin !== settings.launchAtLogin) {
    syncLaunchAtLogin(settings.launchAtLogin, app);
  }
  if (!before || before.petZoom !== settings.petZoom) {
    deps.windowManager?.applyPetWindowZoom(settings.petZoom);
  }
}

export function applyUiIcon(iconSetting: UiIcon, deps: GeneralSettingsLifecycleDependencies): void {
  const icon = nativeImage.createFromPath(getAppIconPath(iconSetting));
  if (icon.isEmpty()) {
    console.warn("[Cyrene] failed to load selected app icon:", iconSetting);
    return;
  }
  deps.tray?.setImage(icon);
  deps.windowManager?.setIconForAllWindows(icon);
}

// Settings listeners and the legacy IPC path may request the same sync concurrently.
let searchMcpSync: Promise<unknown> = Promise.resolve();

export function syncVolcanoSearchMcp(settings: GeneralSettings): Promise<{ mcpSyncResult: string }> {
  const snapshot = { searchEngine: settings.searchEngine, searchMinimaxKey: settings.searchMinimaxKey };
  const run = searchMcpSync.then(() => reconcileMinimaxSearchMcp(snapshot));
  searchMcpSync = run.catch(() => {});
  return run;
}

async function reconcileMinimaxSearchMcp(settings: Pick<GeneralSettings, "searchEngine" | "searchMinimaxKey">): Promise<{ mcpSyncResult: string }> {
  try {
    // Persisted configs also include servers whose previous connection failed.
    const stored = listMcpServerConfigs().find(s => s.id === MINIMAX_SEARCH_MCP_ID);
    const runtime = listMcpServers().find(s => s.id === MINIMAX_SEARCH_MCP_ID);
    const exists = !!stored || !!runtime;
    const enabled = settings.searchEngine === "minimax";
    const key = validateSearchApiKey(settings.searchMinimaxKey ?? "", "MiniMax API Key");
    if (!enabled || !key.valid) {
      if (exists) {
        const removed = await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
        if (!removed.ok) return { mcpSyncResult: "remove_failed" };
      }
      return { mcpSyncResult: enabled ? "key_invalid" : exists ? "removed" : "no_change" };
    }
    const expected = {
      id: MINIMAX_SEARCH_MCP_ID, name: "MiniMax搜索", transport: "stdio" as const,
      command: "uvx", args: ["minimax-coding-plan-mcp", "-y"],
      env: { MINIMAX_API_KEY: key.normalized, MINIMAX_API_HOST: "https://api.minimaxi.com" },
    };
    const unchanged = stored?.transport === expected.transport && stored.command === expected.command
      && JSON.stringify(stored.args ?? []) === JSON.stringify(expected.args)
      && stored.env?.MINIMAX_API_KEY === expected.env.MINIMAX_API_KEY
      && stored.env?.MINIMAX_API_HOST === expected.env.MINIMAX_API_HOST;
    if (unchanged && runtime?.connected) return { mcpSyncResult: "no_change" };
    if (exists) {
      const removed = await removeMcpServer(MINIMAX_SEARCH_MCP_ID);
      if (!removed.ok) return { mcpSyncResult: "remove_failed" };
    }
    const added = await addMcpServer(expected);
    if (!added.ok) return { mcpSyncResult: "register_failed" };
    return { mcpSyncResult: exists ? "reregistered" : "registered" };
  } catch {
    // Connection errors can contain credentials; do not copy them into diagnostics.
    return { mcpSyncResult: "sync_exception" };
  }
}

export function broadcastModelConfigChanged(
  broadcastToAuxWindows: (channel: string, payload: unknown) => void,
  settings = loadModelSettings(),
): void {
  broadcastToAuxWindows(IPC.MODEL_CONFIG_CHANGED, getPublicModelConfig(settings));
}

export function handleGeneralSettingsChanged(
  before: GeneralSettings,
  after: GeneralSettings,
  deps: GeneralSettingsLifecycleDependencies,
): void {
  applyGeneralSettings(after, deps, before);
  syncBuiltInToolToggles(after);
  if (before.language !== after.language || before.asrLanguage !== after.asrLanguage) {
    updateLocaleContext({
      uiLocale: after.language,
      dateLocale: after.language,
      asrLanguage: after.asrLanguage,
    });
  }
  if (before.uiTheme !== after.uiTheme) {
    deps.windowManager?.broadcast(IPC.UI_THEME_CHANGED, getEffectiveUiTheme(after.uiTheme));
  }
  if (before.uiThemeRadius !== after.uiThemeRadius) {
    deps.windowManager?.broadcast(IPC.UI_THEME_RADIUS_CHANGED, after.uiThemeRadius);
  }
  if (before.uiIcon !== after.uiIcon) {
    applyUiIcon(after.uiIcon, deps);
  }
  if (before.screenshotHotkey !== after.screenshotHotkey) {
    const result = deps.screenshotService?.replaceHotkey(after.screenshotHotkey);
    if (result && !result.ok) {
      console.warn("[Cyrene] 截图热键注册失败，可能被其他应用占用:", after.screenshotHotkey);
    }
  }
  if (
    before.proactiveChatMode !== after.proactiveChatMode
    || before.proactiveDeliveryTarget !== after.proactiveDeliveryTarget
  ) {
    deps.proactiveLifecycle.getProactiveChatService()?.invalidate();
  }
  setGetCurrentAppIconPath(() => getAppIconPath(after.uiIcon));
  void syncVolcanoSearchMcp(after);
}
