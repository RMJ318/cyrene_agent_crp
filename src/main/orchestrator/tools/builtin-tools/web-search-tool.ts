// ── 工具：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// webSearchTool 常量，由 built-in-tools.ts facade 在原注册位置统一 toolRegistry.register，
// 显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，门禁见
// built-in-tools.snapshot.test.ts）。

import { createHash } from "node:crypto";
import { validateSearchApiKey } from "../../search-backend-filter";
import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { TtlResultCache } from "./ttl-result-cache";

// ── 工具 5：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。

const SEARCH_TIMEOUT_MS = 20_000;

/** 注入的搜索配置获取器。 */
let searchEngineGetter: (() => string) | null = null;
let searchBochaKeyGetter: (() => string) | null = null;
let searchTavilyKeyGetter: (() => string) | null = null;
let searchAnySearchKeyGetter: (() => string) | null = null;

/**
 * index.ts 启动时调用，注入搜索引擎/各源key 的读取器。
 * engine: "off" | "bocha" | "tavily" | "anySearch" | "minimax"
 */
export function setSearchConfig(
  engineGetter: () => string,
  bochaKeyGetter: () => string,
  tavilyKeyGetter: () => string,
  anySearchKeyGetter: () => string,
): void {
  searchEngineGetter = engineGetter;
  searchBochaKeyGetter = bochaKeyGetter;
  searchTavilyKeyGetter = tavilyKeyGetter;
  searchAnySearchKeyGetter = anySearchKeyGetter;
  clearWebSearchCache();
}

/** 搜索结果统一结构 */
interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/** 搜索输出统一结构（ToolCallResult.output 的 JSON） */
interface WebSearchOutput {
  success: true;
  query: string;
  resultCount: number;
  results: WebSearchResult[];
}

/** snippet 最大长度 */
const MAX_SNIPPET_LEN = 500;

// ── 搜索结果缓存 ─────────────────────────────────────────
// 模型经常在同一会话里反复搜同一关键词（每轮 17~19 个工具调用中就有重复），
// 30 分钟内同引擎同关键词直接复用上次结果。固定 TTL 不续期：新闻/股价类
// 查询的结果不会因频繁访问而保持新鲜，到期必须重搜。
const SEARCH_CACHE_TTL_MS = 30 * 60_000;
const searchCache = new TtlResultCache<WebSearchOutput>(SEARCH_CACHE_TTL_MS);

/** 清空搜索缓存（测试隔离用） */
export function clearWebSearchCache(): void {
  searchCache.clear();
}

/** 截断 snippet */
function truncateSnippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SNIPPET_LEN ? clean.slice(0, MAX_SNIPPET_LEN) + "..." : clean;
}

type SearchEngine = "bocha" | "tavily" | "anySearch";

class WebSearchError extends Error {
  constructor(engine: SearchEngine, code: string, status?: number) {
    super(`搜索失败：${code} (engine=${engine}${status === undefined ? "" : `; HTTP ${status}`})`);
    this.name = code === "E_SEARCH_TIMEOUT" ? "TimeoutError" : "WebSearchError";
  }
}

function record(value: unknown, engine: SearchEngine): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebSearchError(engine, "E_SEARCH_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

async function readSearchResponse(resp: Response, engine: SearchEngine): Promise<Record<string, unknown>> {
  if (!resp.ok) throw new WebSearchError(engine, "E_SEARCH_HTTP_ERROR", resp.status);
  let raw: unknown;
  try { raw = await resp.json(); } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new WebSearchError(engine, "E_SEARCH_RESPONSE_JSON_INVALID");
  }
  const data = record(raw, engine);
  if (data.code !== undefined && data.code !== (engine === "bocha" ? 200 : 0)) {
    throw new WebSearchError(engine, "E_SEARCH_API_ERROR");
  }
  if (data.error !== undefined && data.error !== null) throw new WebSearchError(engine, "E_SEARCH_API_ERROR");
  return data;
}

function resultArray(value: unknown, engine: SearchEngine): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new WebSearchError(engine, "E_SEARCH_RESULTS_INVALID");
  return value.slice(0, 8).map(item => record(item, engine));
}

function resultText(value: unknown, engine: SearchEngine, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string") throw new WebSearchError(engine, "E_SEARCH_RESULT_INVALID");
  return value;
}

function resultUrl(value: unknown, engine: SearchEngine): string {
  const url = resultText(value, engine);
  try {
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch { throw new WebSearchError(engine, "E_SEARCH_RESULT_URL_INVALID"); }
  return url;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("联网搜索已取消", "AbortError");
}

function searchFailure(err: unknown, engine: SearchEngine, parent: AbortSignal | undefined, timeout: AbortSignal): Error {
  if (parent?.aborted) return new DOMException("联网搜索已取消", "AbortError");
  if (timeout.aborted) return new WebSearchError(engine, "E_SEARCH_TIMEOUT");
  return err instanceof WebSearchError ? err : new WebSearchError(engine, "E_SEARCH_NETWORK_ERROR");
}

/** 博查搜索：调 /v1/web-search，返回结构化结果。 */
async function bochaSearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  const url = "https://api.bochaai.com/v1/web-search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        count: 8,
        summary: true,
      }),
    });
    const raw = await readSearchResponse(resp, "bocha");
    const payload = raw.data === undefined ? raw : record(raw.data, "bocha");
    const pages = record(payload.webPages, "bocha");
    const results: WebSearchResult[] = resultArray(pages.value, "bocha").map((r) => ({
      title: resultText(r.name, "bocha"),
      url: resultUrl(r.url, "bocha"),
      snippet: truncateSnippet(resultText(r.summary || r.snippet, "bocha", true)),
      ...(r.siteName ? { source: resultText(r.siteName, "bocha") } : {}),
    }));
    checkCancelled(combinedSignal);
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return output;
  } catch (err) {
    throw searchFailure(err, "bocha", signal, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily 搜索：调 /search，返回结构化结果。 */
async function tavilySearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  const url = "https://api.tavily.com/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        max_results: 8,
        include_answer: false,
      }),
    });
    const data = await readSearchResponse(resp, "tavily");
    const results: WebSearchResult[] = resultArray(data.results, "tavily").map((r) => ({
      title: resultText(r.title, "tavily"),
      url: resultUrl(r.url, "tavily"),
      // Each snippet belongs to its own URL; a synthesized answer is not source evidence.
      snippet: truncateSnippet(resultText(r.content, "tavily", true)),
    }));
    checkCancelled(combinedSignal);
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return output;
  } catch (err) {
    throw searchFailure(err, "tavily", signal, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** AnySearch 搜索：调 /v1/search，返回结构化结果。 */
async function anySearchSearch(query: string, key: string, signal?: AbortSignal): Promise<WebSearchOutput> {
  const url = "https://api.anysearch.com/v1/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers,
      body: JSON.stringify({
        query,
        max_results: 8,
      }),
    });
    const data = await readSearchResponse(resp, "anySearch");
    const payload = record(data.data, "anySearch");
    const results: WebSearchResult[] = resultArray(payload.results, "anySearch").map((r) => ({
      title: resultText(r.title, "anySearch"),
      url: resultUrl(r.url, "anySearch"),
      snippet: truncateSnippet(resultText(r.content || r.snippet, "anySearch", true)),
    }));
    checkCancelled(combinedSignal);
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return output;
  } catch (err) {
    throw searchFailure(err, "anySearch", signal, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function executeWebSearch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  checkCancelled(ctx?.signal);
  const engine = searchEngineGetter?.() ?? "off";
  if (engine === "off") {
    throw new Error("E_SEARCH_NOT_ENABLED");
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("E_SEARCH_QUERY_EMPTY");
  }

  if (engine !== "bocha" && engine !== "tavily" && engine !== "anySearch") throw new Error("E_SEARCH_ENGINE_NOT_SUPPORTED");
  const rawKey = engine === "bocha" ? searchBochaKeyGetter?.() : engine === "tavily" ? searchTavilyKeyGetter?.() : searchAnySearchKeyGetter?.();
  const keyValidation = validateSearchApiKey(rawKey ?? "", "搜索 API Key");
  if (!keyValidation.valid && (engine !== "anySearch" || (rawKey ?? "").trim())) {
    throw new Error(keyValidation.diagnostics.length ? "E_SEARCH_KEY_INVALID" : "E_SEARCH_KEY_MISSING");
  }
  const key = keyValidation.normalized;

  // 缓存命中：标注 cached/cachedAt，让模型自知结果的新鲜度，
  // 回答时效类问题时会带"截至 xx 时间"而不是拿旧缓存当最新
  const credentialScope = createHash("sha256").update(key).digest("hex");
  const cacheKey = engine + "|" + credentialScope + "|" + query.replace(/\s+/g, " ");
  const hit = searchCache.get(cacheKey);
  if (hit) {
    return JSON.stringify({
      ...hit.value,
      cached: true,
      cachedAt: new Date(hit.at).toISOString(),
    });
  }

  let output: WebSearchOutput;
  if (engine === "bocha") {
    output = await bochaSearch(query, key, ctx?.signal);
  } else if (engine === "tavily") {
    output = await tavilySearch(query, key, ctx?.signal);
  } else if (engine === "anySearch") {
    output = await anySearchSearch(query, key, ctx?.signal);
  } else {
    throw new Error(`E_SEARCH_ENGINE_NOT_SUPPORTED:${engine}`);
  }

  // 只有成功走到这里才写缓存；上面的搜索函数失败时会 throw，不会污染缓存
  checkCancelled(ctx?.signal);
  searchCache.set(cacheKey, output);
  return JSON.stringify(output);
}

export const webSearchTool: ToolDefinition = {
  id: "web_search",
  name: "联网搜索",
  description:
    "搜索互联网获取实时信息。返回搜索结果的标题、链接和摘要。\n\n" +
    "何时用：\n" +
    "- 用户问'最近有什么新闻''搜一下 xxx 怎么用''xxx 是什么'\n" +
    "- 用户问的事需要联网才能知道（股价、赛事、最新技术）\n" +
    "- 用户只给关键词，没给具体网址\n\n" +
    "不要用于：\n" +
    "- 用户已经给了明确网址 -> 用 fetch_url\n" +
    "- 用户问本机文件 -> Read / Glob\n" +
    "- 能凭已有知识直接回答的简单问题\n\n" +
    "参数：query（必填，搜索关键词）。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  },
  execute: executeWebSearch,
};

