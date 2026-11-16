// 自定义云端 TTS 引擎
// 固定 HTTP 合约：POST endpointUrl，返回音频二进制或 JSON base64。

import { resolveTimeoutPolicy } from "../runtime-policy";

export interface CustomCloudSynthesizeOptions {
  endpointUrl: string;
  apiKey?: string;
  voiceId?: string;
  text: string;
  speed?: number;
  volume?: number;
  format?: "wav" | "mp3";
  timeoutMs?: number;
  debugLog?: (entry: Record<string, unknown>) => void;
}

export interface CustomCloudSynthesizeResult {
  audio: Buffer;
  format: "wav" | "mp3";
}

const DEFAULT_TIMEOUT_MS = resolveTimeoutPolicy({ stage: "tts-custom-cloud" }).totalMs;

function normalizeFormat(value: unknown, fallback: "wav" | "mp3"): "wav" | "mp3" {
  return value === "wav" || value === "mp3" ? value : fallback;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes("application/json");
}

function guessFormatFromContentType(contentType: string, fallback: "wav" | "mp3"): "wav" | "mp3" {
  const lower = contentType.toLowerCase();
  if (lower.includes("wav") || lower.includes("wave")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  return fallback;
}

export async function synthesize(opts: CustomCloudSynthesizeOptions): Promise<CustomCloudSynthesizeResult> {
  const endpointUrl = opts.endpointUrl?.trim();
  const text = opts.text?.trim();
  const format = opts.format ?? "mp3";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = `custom-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();

  const log = (entry: Record<string, unknown>) => {
    try { opts.debugLog?.({ requestId, ts: new Date().toISOString(), ...entry }); } catch { /* ignore */ }
  };

  if (!endpointUrl) throw new Error("缺少自定义云端 TTS 地址");
  if (!text) throw new Error("缺少合成文本");

  // 仅适配 Fish 官方接口；其他自定义服务继续使用原有合约。
  const endpoint = new URL(endpointUrl);
  const isFish = endpoint.origin === "https://api.fish.audio" && endpoint.pathname === "/v1/tts";
  const voiceId = opts.voiceId?.trim();
  if (isFish && !voiceId) throw new Error("Fish Audio 缺少音色 ID（reference_id），已阻止随机音色合成");
  if (isFish && !opts.apiKey?.trim()) throw new Error("Fish Audio 缺少 API Key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = opts.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (isFish) headers.model = "drama-3";

  log({
    phase: "request.begin",
    endpoint: endpointUrl,
    textChars: Array.from(text).length,
    format,
    timeoutMs,
  });

  let resp: Response;
  try {
    resp = await fetch(endpointUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(isFish ? {
        text,
        reference_id: voiceId,
        format,
        prosody: {
          speed: opts.speed ?? 1,
          // Cyrene 音量为线性倍率，Fish 使用 dB。
          volume: Math.max(-20, Math.min(20, 20 * Math.log10(Math.max(0.0001, opts.volume ?? 1)))),
        },
      } : {
        text,
        voiceId: opts.voiceId?.trim() || undefined,
        speed: opts.speed ?? 1,
        volume: opts.volume ?? 1,
        format,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      log({ phase: "error", error: `合成超时（${timeoutMs}ms）`, durationMs: Date.now() - startedAt });
      throw new Error(`自定义云端 TTS 合成超时（${timeoutMs}ms）`);
    }
    log({ phase: "error", error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    if (isFish) {
      // 不转发上游正文，避免错误正文回显认证信息；不重试或降级音色。
      throw new Error(`Fish Audio 合成失败: HTTP ${resp.status}，请检查 API Key、余额、模型及音色权限`);
    }
    const preview = (await resp.text().catch(() => "")).slice(0, 200);
    log({ phase: "error", status: resp.status, bodyPreview: preview, durationMs: Date.now() - startedAt });
    throw new Error(`自定义云端 TTS 合成失败: ${resp.status} ${preview}`.trim());
  }

  const contentType = resp.headers.get("Content-Type") ?? "";
  if (isFish && !/^(audio\/(mpeg|mp3|wav|wave|x-wav)|application\/octet-stream)(;|$)/i.test(contentType)) {
    throw new Error("Fish Audio 返回非音频响应，已停止播放");
  }
  let audio: Buffer;
  let resultFormat = guessFormatFromContentType(contentType, format);

  if (isJsonContentType(contentType)) {
    const data = (await resp.json()) as {
      audioBase64?: unknown;
      format?: unknown;
    };
    if (typeof data.audioBase64 !== "string" || !data.audioBase64.trim()) {
      throw new Error("自定义云端 TTS 响应缺少 audioBase64");
    }
    audio = Buffer.from(data.audioBase64, "base64");
    resultFormat = normalizeFormat(data.format, format);
  } else {
    audio = Buffer.from(await resp.arrayBuffer());
  }

  if (audio.length === 0) {
    throw new Error("自定义云端 TTS 返回空音频");
  }

  log({
    phase: "response.final",
    durationMs: Date.now() - startedAt,
    audioBytes: audio.length,
    format: resultFormat,
  });

  return { audio, format: resultFormat };
}
