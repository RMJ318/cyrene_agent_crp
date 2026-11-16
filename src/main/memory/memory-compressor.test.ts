import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reflection: vi.fn(), compression: vi.fn(), commit: vi.fn(),
  getAllL2: vi.fn(), upsertL0Field: vi.fn(), replaceL1Field: vi.fn(),
}));
vi.mock("./memory-store", () => ({ memoryStore: {
  getL0: async () => ({}), getL1: async () => ({}),
  getAllL2: mocks.getAllL2, upsertL0Field: mocks.upsertL0Field, replaceL1Field: mocks.replaceL1Field,
  appendReflectionLog: vi.fn(),
} }));
vi.mock("./memory-llm-client", () => ({
  invokeMemoryStructuredOutput: mocks.reflection,
  invokeMemoryLlm: mocks.compression, getDefaultMaxOutputTokens: () => 500,
}));
vi.mock("./memory-manager", () => ({ resolveL1Field: () => "recentGoals" }));
vi.mock("../rag/index", () => ({
  getEntriesBySource: () => [1, 2, 3].map(n => ({ id: "rag" + n, embedding: [1, 0] })),
  addL2MemoryVector: vi.fn(), deleteUserMemoryVectors: vi.fn(),
}));
vi.mock("../rag/vectorstore", () => ({ cosineSimilarity: () => 1 }));
vi.mock("./memory-compression-transaction", () => ({ commitMemoryCompression: mocks.commit }));
import { runMemoryCompression } from "./memory-compressor";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reflection.mockResolvedValue([]);
  mocks.compression.mockResolvedValue({ text: "合并后的测试记忆摘要" });
  mocks.getAllL2.mockResolvedValue([1, 2, 3].map(n => ({ id: "l2_" + n, status: "active", ragId: "rag" + n, content: "mock memory", triggerText: "mock", sourceConversationId: "c1" })));
});

describe("manual maintenance strict failure reporting", () => {
  it("propagates reflection failure for manual runs", async () => {
    mocks.reflection.mockRejectedValue(new Error("MOCK_PROTOCOL_ERROR"));
    await expect(runMemoryCompression({ strict: true })).rejects.toThrow("MOCK_PROTOCOL_ERROR");
    expect(mocks.compression).not.toHaveBeenCalled();
  });
  it("propagates compression failure without committing source changes", async () => {
    mocks.compression.mockRejectedValue(new Error("MOCK_TIMEOUT"));
    await expect(runMemoryCompression({ strict: true })).rejects.toThrow("MOCK_TIMEOUT");
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("does not report an empty compression response as success", async () => {
    mocks.compression.mockResolvedValue({ text: "" });
    await expect(runMemoryCompression({ strict: true })).rejects.toThrow("MEMORY_COMPRESSION_EMPTY_SUMMARY");
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("checks the active mode after generation before writing", async () => {
    let enabled = true;
    mocks.reflection.mockImplementation(async () => {
      enabled = false;
      return [{ layer: "L0", field: "preferredName", content: "mock", confidence: 0.9 }];
    });
    await expect(runMemoryCompression({ strict: true, assertCurrent: () => { if (!enabled) throw new Error("MEMORY_DISABLED"); } })).rejects.toThrow("MEMORY_DISABLED");
    expect(mocks.upsertL0Field).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it("keeps automatic maintenance best-effort behavior", async () => {
    mocks.reflection.mockRejectedValue(new Error("MOCK_FAILURE"));
    await expect(runMemoryCompression()).resolves.toBeUndefined();
  });
});
