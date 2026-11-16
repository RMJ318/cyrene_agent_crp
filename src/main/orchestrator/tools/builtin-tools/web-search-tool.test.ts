// web_search 工具缓存行为测试：同一查询 30 分钟内直接复用并标注新鲜度，
// 失败结果不进缓存。全部用 stub 的 fetch 桩，不发真实网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchCache, setSearchConfig, webSearchTool } from "./web-search-tool";

/** 构造博查 API 形状的 fetch 桩 */
function makeBochaResp(results: Array<{ name: string; url: string; snippet: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ webPages: { value: results } }),
  } as unknown as Response;
}

beforeEach(() => {
  clearWebSearchCache();
  setSearchConfig(() => "bocha", () => "test-key", () => "tavily-key", () => "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web_search 结果缓存", () => {
  it("同一查询两次只搜一次，第二次带 cached/cachedAt 标注", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([
      { name: "结果一", url: "https://example.com/1", snippet: "摘要一" },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const first = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(first.cached).toBeUndefined();
    expect(first.resultCount).toBe(1);

    const second = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(typeof second.cachedAt).toBe("string");
    expect(second.resultCount).toBe(1);
  });

  it("不同查询各自请求", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "AI 新闻" });
    await webSearchTool.execute({ query: "游戏热点" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("关键词空白差异视为同一查询（压空白后同 key）", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "AI  新闻" });
    const second = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it("搜索失败不进缓存：第一次报错，第二次成功则正常返回", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) return { ok: false, status: 500, statusText: "Server Error" } as unknown as Response;
      return makeBochaResp([{ name: "恢复结果", url: "https://example.com/ok", snippet: "ok" }]);
    }));

    await expect(webSearchTool.execute({ query: "股价" })).rejects.toThrow("搜索失败");

    fail = false;
    const second = JSON.parse(await webSearchTool.execute({ query: "股价" })) as Record<string, unknown>;
    expect(second.cached).toBeUndefined();
    expect(second.resultCount).toBe(1);
  });

  it("超过 30 分钟缓存过期，重新搜索", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "今日新闻" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31 * 60_000);
    const second = JSON.parse(await webSearchTool.execute({ query: "今日新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.cached).toBeUndefined();
  });
});


function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
const providerResponses = {
  bocha: { code: 200, data: { webPages: { value: [{ name: "官方来源", url: "https://example.com/bocha", snippet: "网页摘要" }] } } },
  tavily: { answer: "综合回答不属于任一网页", results: [{ title: "官方来源", url: "https://example.com/tavily", content: "网页摘要" }] },
  anySearch: { code: 0, data: { results: [{ title: "", url: "https://example.com/anysearch", snippet: "网页摘要" }] } },
};
function useProvider(engine: string, key = " test-key ") {
  setSearchConfig(() => engine, () => key, () => key, () => key);
}

describe("联网搜索协议与错误边界", () => {
  it.each(["bocha", "tavily", "anySearch"] as const)("%s 返回真实网页摘要并规范鉴权", async engine => {
    useProvider(engine);
    const request = vi.fn(async () => jsonResponse(providerResponses[engine]));
    vi.stubGlobal("fetch", request);
    const output = JSON.parse(await webSearchTool.execute({ query: "mock query" }));
    expect(output).toMatchObject({ success: true, resultCount: 1, results: [{ snippet: "网页摘要" }] });
    expect(output.results[0].url).toMatch(/^https:/);
    expect(output.results[0].snippet).not.toContain("综合回答");
    const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("mock query");
    if (engine === "tavily") expect(body).toMatchObject({ include_answer: false });
  });
  it("AnySearch 允许匿名访问", async () => {
    useProvider("anySearch", "");
    const request = vi.fn(async () => jsonResponse({ code: 0, data: { results: [] } }));
    vi.stubGlobal("fetch", request);
    expect(JSON.parse(await webSearchTool.execute({ query: "mock" })).resultCount).toBe(0);
    expect((request.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("Authorization");
  });
  it.each([
    ["bocha", { code: 401, data: { webPages: { value: [] } } }, "E_SEARCH_API_ERROR"],
    ["bocha", {}, "E_SEARCH_RESPONSE_INVALID"],
    ["tavily", { error: "PRIVATE_KEY" }, "E_SEARCH_API_ERROR"],
    ["tavily", { results: null }, "E_SEARCH_RESULTS_INVALID"],
    ["tavily", { results: [{ title: "bad", url: "javascript:alert(1)", content: "" }] }, "E_SEARCH_RESULT_URL_INVALID"],
    ["anySearch", { code: -1, data: { results: [] } }, "E_SEARCH_API_ERROR"],
    ["anySearch", { code: 0, data: {} }, "E_SEARCH_RESULTS_INVALID"],
    ["anySearch", { code: 0, data: { results: [null] } }, "E_SEARCH_RESPONSE_INVALID"],
    ["anySearch", null, "E_SEARCH_RESPONSE_INVALID"],
  ])("%s 的异常响应不伪装为空结果也不缓存", async (engine, invalid, reason) => {
    useProvider(engine as string);
    const request = vi.fn().mockResolvedValueOnce(jsonResponse(invalid)).mockResolvedValueOnce(jsonResponse(providerResponses[engine as keyof typeof providerResponses]));
    vi.stubGlobal("fetch", request);
    const error = await webSearchTool.execute({ query: "same query" }).catch(e => e);
    expect(error.message).toContain(reason);
    expect(error.message).not.toContain("PRIVATE_KEY");
    const recovered = JSON.parse(await webSearchTool.execute({ query: "same query" }));
    expect(recovered.success).toBe(true);
    expect(recovered.cached).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([401, 429, 500])("HTTP %s 不读取或泄漏错误正文", async status => {
    const json = vi.fn(async () => ({ message: "PRIVATE_KEY" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, json })));
    await expect(webSearchTool.execute({ query: "mock" })).rejects.toThrow("HTTP " + status);
    expect(json).not.toHaveBeenCalled();
  });
  it("JSON 语法异常不泄漏原始响应", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("PRIVATE_RESPONSE"); } })));
    const error = await webSearchTool.execute({ query: "mock" }).catch(e => e);
    expect(error.message).toContain("E_SEARCH_RESPONSE_JSON_INVALID");
    expect(error.message).not.toContain("PRIVATE_RESPONSE");
  });
  it("凭据轮换不复用旧缓存，删除密钥不能绕过校验", async () => {
    let key = "first-key";
    setSearchConfig(() => "bocha", () => key, () => "", () => "");
    const request = vi.fn(async () => jsonResponse(providerResponses.bocha));
    vi.stubGlobal("fetch", request);
    await webSearchTool.execute({ query: "mock" });
    key = "second-key";
    expect(JSON.parse(await webSearchTool.execute({ query: "mock" })).cached).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    key = "";
    await expect(webSearchTool.execute({ query: "mock" })).rejects.toThrow("E_SEARCH_KEY_MISSING");
  });
  it.each(["含中文", "key\ninside"])("非法凭据在网络请求前拒绝: %s", async key => {
    useProvider("bocha", key);
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(webSearchTool.execute({ query: "mock" })).rejects.toThrow("E_SEARCH_KEY_INVALID");
    expect(request).not.toHaveBeenCalled();
  });
  it("缓存命中也必须遵守父运行取消", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(providerResponses.bocha)));
    await webSearchTool.execute({ query: "mock" });
    const controller = new AbortController(); controller.abort();
    await expect(webSearchTool.execute({ query: "mock" }, { userQuery: "", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each(["bocha", "tavily", "anySearch"] as const)("%s 的响应体读取同样受超时和取消约束", async engine => {
    useProvider(engine);
    vi.useFakeTimers();
    const request = vi.fn(async (_url, init: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
    }));
    vi.stubGlobal("fetch", request);
    const timed = webSearchTool.execute({ query: "mock" }).catch(e => e);
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await timed).message).toContain("E_SEARCH_TIMEOUT");
    const controller = new AbortController();
    const cancelled = webSearchTool.execute({ query: "mock" }, { userQuery: "", signal: controller.signal }).catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
