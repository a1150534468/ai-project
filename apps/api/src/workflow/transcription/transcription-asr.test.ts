import { describe, expect, it } from "vitest";
import {
  downloadTranscriptionResult,
  isRetryableAsrError,
  loadAsrConfig,
  parseTranscriptionResult,
  pollTranscriptionStatus,
  submitTranscription,
  AsrApiError,
  AsrConfigError,
  type AsrConfig,
} from "./transcription-asr.js";

const CONFIG: AsrConfig = {
  baseURL: "https://workspace-id.cn-beijing.maas.aliyuncs.com",
  apiKey: "test-key",
  model: "qwen-audio-3.1-asr-flash-filetrans",
  submitTimeoutMs: 5000,
  pollTimeoutMs: 5000,
  downloadTimeoutMs: 5000,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    return handler(String(url), init);
  }) as unknown as typeof fetch;
}

describe("loadAsrConfig", () => {
  it("缺少 key 时抛 AsrConfigError", () => {
    expect(() => loadAsrConfig({ BAILIAN_WORKSPACE_ID: "ws" })).toThrow(AsrConfigError);
  });

  it("缺少 workspace 且无 baseURL 覆盖时抛 AsrConfigError", () => {
    expect(() => loadAsrConfig({ BAILIAN_API_KEY: "k" })).toThrow(AsrConfigError);
  });

  it("用 workspace 拼出北京接入点", () => {
    const cfg = loadAsrConfig({ BAILIAN_API_KEY: "k", BAILIAN_WORKSPACE_ID: "ws123" });
    expect(cfg.baseURL).toBe("https://ws123.cn-beijing.maas.aliyuncs.com");
    expect(cfg.model).toBe("qwen-audio-3.1-asr-flash-filetrans");
  });

  it("DASHSCOPE_API_KEY 可作为 key 备选", () => {
    const cfg = loadAsrConfig({ DASHSCOPE_API_KEY: "k2", BAILIAN_WORKSPACE_ID: "ws" });
    expect(cfg.apiKey).toBe("k2");
  });
});

describe("submitTranscription", () => {
  it("按官方文档形状提交并返回 task_id", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const fetchFn = mockFetch((url, init) => {
      seenUrl = url;
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      seenBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { output: { task_id: "task-123", task_status: "PENDING" }, request_id: "req-1" });
    });
    const taskId = await submitTranscription({
      config: CONFIG,
      fileUrl: "https://public.example.com/audio.mp3",
      languageHints: ["zh"],
      fetchFn,
    });
    expect(taskId).toBe("task-123");
    expect(seenUrl).toBe(`${CONFIG.baseURL}/api/v1/services/audio/asr/transcription`);
    expect(seenHeaders["X-DashScope-Async"]).toBe("enable");
    expect(seenHeaders["Authorization"]).toBe("Bearer test-key");
    expect(seenBody).toMatchObject({
      model: "qwen-audio-3.1-asr-flash-filetrans",
      input: { file_urls: ["https://public.example.com/audio.mp3"] },
      parameters: { channel_id: [0], language_hints: ["zh"] },
    });
  });

  it("缺少 task_id 时抛错", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, { output: {} }));
    await expect(submitTranscription({ config: CONFIG, fileUrl: "u", languageHints: ["zh"], fetchFn }))
      .rejects.toThrow(AsrApiError);
  });

  it("429 可重试、400 永久失败", async () => {
    const tooMany = mockFetch(() => jsonResponse(429, { message: "throttled" }));
    const bad = mockFetch(() => jsonResponse(400, { message: "bad request" }));
    const err429 = await submitTranscription({ config: CONFIG, fileUrl: "u", languageHints: ["zh"], fetchFn: tooMany }).catch((e) => e);
    const err400 = await submitTranscription({ config: CONFIG, fileUrl: "u", languageHints: ["zh"], fetchFn: bad }).catch((e) => e);
    expect(isRetryableAsrError(err429)).toBe(true);
    expect(isRetryableAsrError(err400)).toBe(false);
  });
});

describe("pollTranscriptionStatus", () => {
  it("SUCCEEDED 时取出 transcription_url", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, {
      output: {
        task_id: "task-123",
        task_status: "SUCCEEDED",
        results: [{ transcription_url: "https://result.example.com/r.json", subtask_status: "SUCCEEDED" }],
      },
    }));
    const job = await pollTranscriptionStatus({ config: CONFIG, taskId: "task-123", fetchFn });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.transcriptionUrl).toBe("https://result.example.com/r.json");
  });

  it("PENDING/RUNNING 时 transcriptionUrl 为空", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, { output: { task_status: "RUNNING" } }));
    const job = await pollTranscriptionStatus({ config: CONFIG, taskId: "t", fetchFn });
    expect(job.status).toBe("RUNNING");
    expect(job.transcriptionUrl).toBeNull();
  });

  it("FAILED 透出 message", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, {
      output: { task_status: "FAILED", message: "audio too long" },
    }));
    const job = await pollTranscriptionStatus({ config: CONFIG, taskId: "t", fetchFn });
    expect(job.status).toBe("FAILED");
    expect(job.message).toBe("audio too long");
  });
});

describe("parseTranscriptionResult", () => {
  const payload = {
    file_url: "https://public.example.com/audio.mp3",
    transcripts: [{
      channel_id: 0,
      text: "Hello World，这里是测试。",
      sentences: [{
        begin_time: 760,
        end_time: 3240,
        text: "Hello World，这里是测试。",
        words: [
          { begin_time: 760, end_time: 1000, text: "Hello", punctuation: "" },
          { begin_time: 1000, end_time: 3240, text: "这里是测试。", punctuation: "。" },
        ],
      }],
    }],
  };

  it("抽出全文与句/字级时间戳", () => {
    const result = parseTranscriptionResult(payload);
    expect(result.text).toBe("Hello World，这里是测试。");
    expect(result.sentences).toHaveLength(1);
    expect(result.sentences[0]).toMatchObject({ beginMs: 760, endMs: 3240 });
    expect(result.sentences[0].words).toHaveLength(2);
    expect(result.sentences[0].words[0]).toMatchObject({ beginMs: 760, text: "Hello" });
  });

  it("缺少 transcripts 时抛错", () => {
    expect(() => parseTranscriptionResult({})).toThrow(AsrApiError);
    expect(() => parseTranscriptionResult(null)).toThrow(AsrApiError);
  });

  it("空 sentences 返回空文本不抛错", () => {
    const result = parseTranscriptionResult({ transcripts: [] });
    expect(result.text).toBe("");
    expect(result.sentences).toEqual([]);
  });
});

describe("downloadTranscriptionResult", () => {
  it("下载并解析", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, {
      transcripts: [{ sentences: [{ begin_time: 0, end_time: 1000, text: "你好" }] }],
    }));
    const result = await downloadTranscriptionResult({
      config: CONFIG,
      transcriptionUrl: "https://result.example.com/r.json",
      fetchFn,
    });
    expect(result.text).toBe("你好");
  });

  it("下载 500 可重试", async () => {
    const fetchFn = mockFetch(() => jsonResponse(500, {}));
    const error = await downloadTranscriptionResult({
      config: CONFIG,
      transcriptionUrl: "https://result.example.com/r.json",
      fetchFn,
    }).catch((e) => e);
    expect(isRetryableAsrError(error)).toBe(true);
  });
});
