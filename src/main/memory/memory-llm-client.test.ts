import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  MemoryLlmTimeoutError,
  MemoryLlmHttpError,
  MemoryLlmProtocolError,
  MemoryLlmConfigurationError,
} from "./memory-llm-errors";

// ── Hoisted mock state ──
const mockConfig = vi.hoisted(() => ({
  value: { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "sk-test" },
  requests: [] as Array<Record<string, unknown>>,
}));

// ── Mocks ──
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/test-user-data" },
}));

vi.mock("../runtime-policy", () => ({
  resolveTimeoutPolicy: () => ({ totalMs: 30_000 }),
  resolveMaxOutputTokens: ({ stage }: { stage: string }) => {
    const map: Record<string, number> = {
      "memory-judge": 800,
      "memory-compressor": 500,
      "memory-reflect": 500,
      "memory-resolver": 700,
    };
    return map[stage] ?? 500;
  },
}));

vi.mock("./memory-llm-shared", () => ({
  loadMemoryModelConfig: () => mockConfig.value,
  stripThinkBlocks: (t: string) => t,
}));

vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
  recordRequest: vi.fn(),
}));

vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: vi.fn(() => ({
    buildRequest: (req: Record<string, unknown>, cfg: { model: string }) => {
      mockConfig.requests.push(req);
      return {
        url: `https://test.api/v1/chat/completions`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model }),
      };
    },
    parseResponse: (data: unknown) => {
      const d = data as { text?: string; finishReason?: string; usage?: { input: number; output: number } };
      return { text: d.text ?? "", finishReason: d.finishReason ?? "stop", usage: d.usage };
    },
  })),
}));

// ── Import after mocks ──
import {
  getDefaultMaxOutputTokens,
  invokeMemoryLlm,
  invokeMemoryStructuredOutput,
} from "./memory-llm-client";
import {
  parseMemoryJudgeResult,
  validateMemoryJudgeBusiness,
  parseMemoryReflectionResult,
  validateMemoryReflectionBusiness,
} from "./memory-schemas";

// ── Tests ──

beforeEach(() => {
  vi.restoreAllMocks();
  mockConfig.value = { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "sk-test" };
  mockConfig.requests = [];
});

describe("invokeMemoryStructuredOutput — repair context", () => {
  it("adds validation feedback to a judge repair request", async () => {
    const responses = [
      { text: "not json", finishReason: "stop" },
      { text: '{"candidates":[]}', finishReason: "stop" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift(),
    })));

    await expect(invokeMemoryStructuredOutput({
      operation: "judge",
      systemPrompt: "system",
      userPrompt: "conversation",
      maxOutputTokens: 800,
      parseSchema: parseMemoryJudgeResult,
      validateBusiness: validateMemoryJudgeBusiness,
    })).resolves.toEqual({ candidates: [], entities: [] });

    const repairMessages = mockConfig.requests[1]?.messages as Array<{ role: string; content: string }>;
    expect(repairMessages.at(-1)?.content).toContain("NO_JSON_OBJECT");
    expect(repairMessages.at(-1)?.content).toContain('{"candidates":[],"entities":[]}');
  });

  it("reflect repair instructs updates format, not groups", async () => {
    const responses = [
      { text: "bad", finishReason: "stop" },
      { text: '{"updates":[]}', finishReason: "stop" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => responses.shift(),
    })));

    await expect(invokeMemoryStructuredOutput({
      operation: "reflect",
      systemPrompt: "system",
      userPrompt: "conversation",
      maxOutputTokens: 500,
      parseSchema: parseMemoryReflectionResult,
      validateBusiness: validateMemoryReflectionBusiness,
    })).resolves.toEqual([]);

    const repairMessages = mockConfig.requests[1]?.messages as Array<{ role: string; content: string }>;
    expect(repairMessages.at(-1)?.content).toContain('{"updates":[...]}');
    expect(repairMessages.at(-1)?.content).not.toContain('{"groups":[...]}');
  });
});

describe("getDefaultMaxOutputTokens", () => {
  it("returns correct defaults for each operation", () => {
    expect(getDefaultMaxOutputTokens("judge")).toBe(800);
    expect(getDefaultMaxOutputTokens("compress")).toBe(500);
    expect(getDefaultMaxOutputTokens("reflect")).toBe(500);
    expect(getDefaultMaxOutputTokens("resolve")).toBe(700);
  });
});

describe("MemoryLlmError types", () => {
  it("MemoryLlmTimeoutError has correct message and fields", () => {
    const err = new MemoryLlmTimeoutError(30000, "judge");
    expect(err.name).toBe("MemoryLlmTimeoutError");
    expect(err.timeoutMs).toBe(30000);
    expect(err.operation).toBe("judge");
    expect(err.message).toContain("judge");
    expect(err.message).toContain("30000");
  });

  it("MemoryLlmHttpError preserves status code and operation", () => {
    const err = new MemoryLlmHttpError(401, "compress", "Unauthorized");
    expect(err.name).toBe("MemoryLlmHttpError");
    expect(err.statusCode).toBe(401);
    expect(err.operation).toBe("compress");
    expect(err.responseBody).toBe("Unauthorized");
    expect(err.message).toContain("401");
    expect(err.message).toContain("compress");
  });

  it("MemoryLlmHttpError works without responseBody", () => {
    const err = new MemoryLlmHttpError(500, "resolve");
    expect(err.responseBody).toBeUndefined();
  });

  it("MemoryLlmProtocolError preserves detail", () => {
    const err = new MemoryLlmProtocolError("resolve", "null text");
    expect(err.name).toBe("MemoryLlmProtocolError");
    expect(err.operation).toBe("resolve");
    expect(err.detail).toBe("null text");
  });

  it("MemoryLlmConfigurationError has detail message", () => {
    const err = new MemoryLlmConfigurationError("missing API key");
    expect(err.name).toBe("MemoryLlmConfigurationError");
    expect(err.message).toContain("missing API key");
  });

  it("all error types extend Error", () => {
    expect(new MemoryLlmTimeoutError(1000, "j")).toBeInstanceOf(Error);
    expect(new MemoryLlmHttpError(500, "c")).toBeInstanceOf(Error);
    expect(new MemoryLlmProtocolError("r", "d")).toBeInstanceOf(Error);
    expect(new MemoryLlmConfigurationError("d")).toBeInstanceOf(Error);
  });
});

describe("invokeMemoryLlm — configuration validation", () => {
  it("throws MemoryLlmConfigurationError when API key is missing", async () => {
    mockConfig.value = { provider: "test", baseUrl: "https://test.api/v1", model: "test-model", apiKey: "" };

    await expect(
      invokeMemoryLlm({
        operation: "judge",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 800,
      }),
    ).rejects.toThrow(MemoryLlmConfigurationError);
  });
});

describe("invokeMemoryLlm — error distinction", () => {
  it("external signal abort is NOT wrapped as MemoryLlmTimeoutError", async () => {
    // fetch hangs until signal aborts
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }));

    const controller = new AbortController();
    const promise = invokeMemoryLlm({
      operation: "judge",
      messages: [{ role: "user", content: "test" }],
      maxOutputTokens: 800,
      signal: controller.signal,
    });

    // Abort externally after a short delay
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toThrow(/cancelled by external signal/);
    await expect(promise).rejects.not.toThrow(MemoryLlmTimeoutError);
  });

  it("HTTP error body is truncated to 1500 chars", async () => {
    const longMessage = "x".repeat(5000);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: longMessage } }),
    })));

    try {
      await invokeMemoryLlm({
        operation: "compress",
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: 500,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryLlmHttpError);
      const httpErr = err as MemoryLlmHttpError;
      expect(httpErr.responseBody).toContain("…(truncated)");
      // 1500 chars of content + "…(truncated)" suffix
      expect(httpErr.responseBody!.length).toBeLessThanOrEqual(1520);
    }
  });
});


describe("Memory Judge safe diagnostics", () => {
  const invoke = () => invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "system", userPrompt: "PRIVATE_CHAT", maxOutputTokens: 800, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness });
  it.each([
    ["", "stop", "EMPTY_RESPONSE"],
    ['{"candidates":', "stop", "JSON_SYNTAX_ERROR"],
    ['null', "stop", "JSON_TOP_LEVEL_TYPE"],
    ['{"candidates":[{"layer":"PRIVATE_CHAT"}]}', "stop", "NO_SCHEMA_VALID_OBJECT at candidates[0].layer"],
    ['{"candidates":[]}', "length", "TRUNCATED_OUTPUT"],
  ])("distinguishes invalid output without disclosing content: %s", async (text, finishReason, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ text, finishReason }) })));
    const error = await invoke().catch(e => e);
    expect(error).toBeInstanceOf(MemoryLlmProtocolError);
    expect(error.message).toContain(reason);
    expect(error.message).toContain("responseType:");
    expect(error.message).not.toContain("PRIVATE_CHAT");
    expect(mockConfig.requests).toHaveLength(3);
  });
  it("increases the repair budget only after truncation", async () => {
    const responses = [{ text: '{"candidates":', finishReason: "length" }, { text: '{"candidates":[],"entities":[]}', finishReason: "stop" }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => responses.shift() })));
    await expect(invoke()).resolves.toEqual({ candidates: [], entities: [] });
    expect(mockConfig.requests.map(r => r.maxTokens)).toEqual([800, 1600]);
  });
  it("classifies invalid HTTP JSON as protocol failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("PRIVATE_CHAT"); } })));
    await expect(invoke()).rejects.toThrow("MODEL_PROTOCOL_ERROR");
  });
});


describe("Sonnet 4.6 wire contract (mock HTTP)", () => {
  it.each([false, true])("supports official/custom Anthropic endpoints: %s", async custom => {
    const { getAdapterForConfig } = await import("../orchestrator/vendors");
    const { AnthropicAdapter } = await import("../orchestrator/vendors/anthropic-adapter");
    const { PROVIDER_CAPABILITIES } = await import("../orchestrator/vendors/capabilities");
    const cap = PROVIDER_CAPABILITIES.find(c => c.id === "claude")!;
    vi.mocked(getAdapterForConfig).mockReturnValueOnce(new AnthropicAdapter("claude", cap));
    let wire: Record<string, any> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      wire = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ content: [{ type: "text", text: '{"candidates":[],"entities":[]}' }], stop_reason: "end_turn" }) };
    }));
    await expect(invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "JSON", userPrompt: "mock", maxOutputTokens: 800, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness,
      config: { source: "inherited-main", provider: cap.displayName, model: "claude-sonnet-4-6", baseUrl: custom ? "https://proxy.test" : cap.baseUrl, apiKey: "mock", explicitTransport: "anthropic" },
    })).resolves.toEqual({ candidates: [], entities: [] });
    if (custom) expect(wire.output_config?.format).toBeUndefined();
    else expect(wire.output_config.format.type).toBe("json_schema");
    expect(wire.thinking?.type).not.toBe("adaptive");
  });
  it("rejects an OpenAI envelope on an Anthropic endpoint", async () => {
    const { getAdapterForConfig } = await import("../orchestrator/vendors");
    const { AnthropicAdapter } = await import("../orchestrator/vendors/anthropic-adapter");
    const { PROVIDER_CAPABILITIES } = await import("../orchestrator/vendors/capabilities");
    vi.mocked(getAdapterForConfig).mockReturnValueOnce(new AnthropicAdapter("claude", PROVIDER_CAPABILITIES.find(c => c.id === "claude")!));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) })));
    await expect(invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "system", userPrompt: "mock", maxOutputTokens: 800, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness })).rejects.toThrow("MODEL_PROTOCOL_ERROR");
  });
});


it.each([false, true])("distinguishes timeout and external cancellation: %s", async cancelled => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const controller = new AbortController();
    const result = invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "system", userPrompt: "mock", maxOutputTokens: 800, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness, signal: controller.signal }).catch(e => e);
    if (cancelled) controller.abort();
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await result).message).toContain(cancelled ? "CANCELLED" : "MODEL_REQUEST_TIMEOUT");
  } finally { vi.useRealTimers(); }
});


it("命名空间 DeepSeek 的 Responses 记忆请求关闭推理，并在明确截断后扩大预算", async () => {
  const { getAdapterForConfig } = await import("../orchestrator/vendors");
  const { ResponsesAdapter } = await import("../orchestrator/vendors/responses-adapter");
  const { getCapabilityOrOpenAI } = await import("../orchestrator/vendors/capabilities");
  const cap = getCapabilityOrOpenAI("自定义端点（云端）");
  vi.mocked(getAdapterForConfig).mockReturnValueOnce(new ResponsesAdapter(cap.id, cap));
  const bodies: Array<Record<string, any>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return { ok: true, json: async () => bodies.length === 1
      ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 100, output_tokens: 2048, output_tokens_details: { reasoning_tokens: 2048 } } }
      : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"candidates":[],"entities":[]}' }] }] } };
  }));
  await expect(invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "JSON", userPrompt: "mock", maxOutputTokens: 2048, parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness,
    config: { source: "inherited-main", provider: "自定义端点（云端）", model: "deepseek/deepseek-v4.1-flash", baseUrl: "https://proxy.example/v1", apiKey: "mock", explicitTransport: "responses" },
  })).resolves.toEqual({ candidates: [], entities: [] });
  expect(bodies.map(b => b.max_output_tokens)).toEqual([2048, 4096]);
  expect(bodies.every(b => b.model === "deepseek/deepseek-v4.1-flash")).toBe(true);
  expect(bodies.every(b => b.reasoning?.effort === "none")).toBe(true);
});


it("推理耗尽输出预算时保留安全计数且修复有上限，不误报成功", async () => {
  const { getAdapterForConfig } = await import("../orchestrator/vendors");
  const { ResponsesAdapter } = await import("../orchestrator/vendors/responses-adapter");
  const { getCapabilityOrOpenAI } = await import("../orchestrator/vendors/capabilities");
  const cap = getCapabilityOrOpenAI("自定义端点（云端）");
  vi.mocked(getAdapterForConfig).mockReturnValueOnce(new ResponsesAdapter(cap.id, cap));
  const limits: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const body = JSON.parse(init.body as string); limits.push(body.max_output_tokens);
    return { ok: true, json: async () => ({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {
      output_tokens: body.max_output_tokens, output_tokens_details: { reasoning_tokens: body.max_output_tokens },
    } }) };
  }));
  const error = await invokeMemoryStructuredOutput({ operation: "judge", systemPrompt: "JSON", userPrompt: "PRIVATE_CHAT", maxOutputTokens: 2048,
    parseSchema: parseMemoryJudgeResult, validateBusiness: validateMemoryJudgeBusiness,
    config: { source: "inherited-main", provider: "自定义端点（云端）", model: "deepseek/deepseek-v4.1-flash", baseUrl: "https://proxy.example/v1", apiKey: "mock", explicitTransport: "responses" },
  }).catch(e => e);
  expect(error.message).toContain("REPAIR_EXHAUSTED");
  expect(error.message).toContain('"reasoningTokens":8192');
  expect(error.message).not.toContain("PRIVATE_CHAT");
  expect(limits).toEqual([2048, 4096, 8192]);
});
