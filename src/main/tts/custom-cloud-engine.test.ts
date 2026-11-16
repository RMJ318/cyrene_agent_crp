import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesize } from "./custom-cloud-engine";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("custom-cloud-engine synthesize", () => {
  const fishEndpoint = "https://api.fish.audio/v1/tts";

  it("binds the configured Fish voice through reference_id and consumes binary audio", async () => {
    const audio = Buffer.from("ID3fish");
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(audio, {
      headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await synthesize({ endpointUrl: fishEndpoint, apiKey: "test-key", voiceId: " voice-123 ", text: "hello", volume: 1 });
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key", model: "drama-3" });
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello", reference_id: "voice-123", format: "mp3", prosody: { speed: 1, volume: 0 } });
    expect(result.audio).toEqual(audio);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "   "])("blocks missing Fish voice %s before sending a request", async (voiceId) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesize({ endpointUrl: fishEndpoint, apiKey: "test-key", voiceId, text: "hello" })).rejects.toThrow(/reference_id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires authentication for Fish", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesize({ endpointUrl: fishEndpoint, voiceId: "voice", text: "hello" })).rejects.toThrow(/API Key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403, 404, 422, 500])("does not retry or leak upstream errors on Fish HTTP %s", async (status) => {
    const fetchMock = vi.fn(async () => new Response("secret-key-echo", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.fn();
    await expect(synthesize({ endpointUrl: fishEndpoint, apiKey: "secret-key-echo", voiceId: "voice", text: "hello", debugLog: log })).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-key-echo");
  });

  it.each(["application/json", "text/html"])("rejects a successful non-audio Fish response (%s)", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("error", { headers: { "Content-Type": contentType } })));
    await expect(synthesize({ endpointUrl: fishEndpoint, apiKey: "key", voiceId: "voice", text: "hello" })).rejects.toThrow(/非音频/);
  });

  it("rejects empty Fish audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { headers: { "Content-Type": "audio/mpeg" } })));
    await expect(synthesize({ endpointUrl: fishEndpoint, apiKey: "key", voiceId: "voice", text: "hello" })).rejects.toThrow(/空音频/);
  });

  it("rejects missing endpointUrl", async () => {
    await expect(synthesize({ endpointUrl: "", text: "hello" })).rejects.toThrow(/自定义云端 TTS 地址/);
  });

  it("rejects missing text", async () => {
    await expect(synthesize({ endpointUrl: "https://tts.example.com", text: "" })).rejects.toThrow(/合成文本/);
  });

  it("parses binary audio responses", async () => {
    const audio = Buffer.from("ID3fake");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(audio, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      apiKey: "k",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("mp3");
  });

  it("sends voiceId in the standard request body", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(Buffer.from("ID3fake"), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });

    const request = fetchMock.mock.calls[0]?.[1];
    if (!request) throw new Error("missing fetch request init");
    expect(JSON.parse(String(request.body))).toMatchObject({
      text: "hi",
      voiceId: "cyrene-voice",
      format: "mp3",
    });
  });

  it("parses JSON base64 responses", async () => {
    const audio = Buffer.from("RIFFfake");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      audioBase64: audio.toString("base64"),
      format: "wav",
    })));

    const result = await synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
      format: "mp3",
    });

    expect(result.audio.equals(audio)).toBe(true);
    expect(result.format).toBe("wav");
  });

  it("reports HTTP errors with response preview", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));

    await expect(synthesize({
      endpointUrl: "https://tts.example.com",
      text: "hi",
    })).rejects.toThrow(/400 bad request/);
  });
});
