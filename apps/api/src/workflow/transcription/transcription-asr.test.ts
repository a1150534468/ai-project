import { describe, expect, it } from "vitest";
import {
  downloadTranscriptionResult,
  isPubliclyReachableUrl,
  isRetryableAsrError,
  loadAsrConfig,
  parseTranscriptionResult,
  pollTranscriptionStatus,
  submitTranscription,
  uploadToDashScopeTempStorage,
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

describe("isPubliclyReachableUrl", () => {
  it("公网 http(s) 地址放行", () => {
    expect(isPubliclyReachableUrl("https://cdn.example.com/a.mp3")).toBe(true);
    expect(isPubliclyReachableUrl("http://8.8.8.8/a.mp3")).toBe(true);
  });

  // 本地开发就是死在这条上：MinIO 报 http://localhost:9000/...，百炼那边解析不了，
  // 任务跑四十多秒后只回一个 code=SERVER_ERROR。
  it.each([
    "http://localhost:9000/bucket/a.mp3",
    "http://127.0.0.1:9000/a.mp3",
    "http://0.0.0.0:9000/a.mp3",
    "http://10.1.2.3/a.mp3",
    "http://172.16.5.4/a.mp3",
    "http://172.31.5.4/a.mp3",
    "http://192.168.1.20/a.mp3",
    "http://169.254.1.1/a.mp3",
    "http://minio.local/a.mp3",
    "http://minio:9000/a.mp3",
    "http://[::1]:9000/a.mp3",
    "http://[fd00::1]/a.mp3",
  ])("内网/回环地址不通：%s", (url) => {
    expect(isPubliclyReachableUrl(url)).toBe(false);
  });

  it("172.32 不是私网段，别误伤", () => {
    expect(isPubliclyReachableUrl("http://172.32.0.1/a.mp3")).toBe(true);
  });

  it("非 http(s) 一律不通（oss:// 走另一条分支）", () => {
    expect(isPubliclyReachableUrl("oss://dashscope-instant/x.mp3")).toBe(false);
    expect(isPubliclyReachableUrl("file:///tmp/a.mp3")).toBe(false);
    expect(isPubliclyReachableUrl("不是地址")).toBe(false);
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
    // 公网直链不该带这枚头：它只用于解析 oss:// 临时地址
    expect(seenHeaders["X-DashScope-OssResourceResolve"]).toBeUndefined();
    expect(seenBody).toMatchObject({
      model: "qwen-audio-3.1-asr-flash-filetrans",
      input: { file_urls: ["https://public.example.com/audio.mp3"] },
      parameters: { channel_id: [0], language_hints: ["zh"] },
    });
  });

  it("oss:// 地址要带上 OSS 解析头，否则百炼只当普通 URL", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchFn = mockFetch((_url, init) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(200, { output: { task_id: "task-oss" } });
    });
    const taskId = await submitTranscription({
      config: CONFIG,
      fileUrl: "oss://dashscope-instant/dir/audio.m4a",
      languageHints: ["zh"],
      fetchFn,
    });
    expect(taskId).toBe("task-oss");
    expect(seenHeaders["X-DashScope-OssResourceResolve"]).toBe("enable");
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

describe("uploadToDashScopeTempStorage", () => {
  const UPLOAD_DIR = "dashscope-instant/ws-1/2026-10-19/61f0d9a0";
  const POLICY = {
    data: {
      upload_dir: UPLOAD_DIR,
      upload_host: "https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com",
      oss_access_key_id: "ak-temp",
      signature: "sig",
      policy: "policy-base64",
      x_oss_object_acl: "private",
      x_oss_forbid_overwrite: "true",
    },
  };

  it("先取上传凭证、再走 OSS 表单，返回 oss:// 地址", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchFn = mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body });
      if (url.includes("/api/v1/uploads")) return jsonResponse(200, POLICY);
      return new Response("", { status: 200 });
    });

    const ossUrl = await uploadToDashScopeTempStorage({
      config: CONFIG,
      bytes: Buffer.from("fake-audio"),
      fileName: "会议 录音.m4a",
      contentType: "audio/mp4",
      fetchFn,
    });

    expect(ossUrl).toBe(`oss://${UPLOAD_DIR}/会议 录音.m4a`);
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0].url).toContain("action=getPolicy");
    expect(calls[0].url).toContain(encodeURIComponent(CONFIG.model));
    expect(calls[1].url).toBe(POLICY.data.upload_host);
    expect(calls[1].method).toBe("POST");

    const form = calls[1].body as FormData;
    expect(form.get("key")).toBe(`${UPLOAD_DIR}/会议 录音.m4a`);
    expect(form.get("OSSAccessKeyId")).toBe("ak-temp");
    expect(form.get("success_action_status")).toBe("200");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("文件名里的路径分隔符会被拍平，不会跑出 upload_dir", async () => {
    const fetchFn = mockFetch((url) => {
      if (url.includes("/api/v1/uploads")) return jsonResponse(200, POLICY);
      return new Response("", { status: 200 });
    });
    const ossUrl = await uploadToDashScopeTempStorage({
      config: CONFIG,
      bytes: Buffer.from("x"),
      fileName: "../../etc/passwd.m4a",
      contentType: "audio/mp4",
      fetchFn,
    });

    expect(ossUrl.startsWith(`oss://${UPLOAD_DIR}/`)).toBe(true);
    expect(ossUrl.slice(`oss://${UPLOAD_DIR}/`.length)).not.toContain("/");
  });

  it("凭证字段不全时抛 AsrApiError，不拿半张凭证去上传", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, { data: { upload_dir: "d" } }));
    const error = await uploadToDashScopeTempStorage({
      config: CONFIG,
      bytes: Buffer.from("x"),
      fileName: "a.m4a",
      contentType: "audio/mp4",
      fetchFn,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AsrApiError);
  });

  it("取凭证 4xx 是永久失败", async () => {
    const fetchFn = mockFetch(() => jsonResponse(401, { code: "InvalidApiKey" }));
    const error = await uploadToDashScopeTempStorage({
      config: CONFIG,
      bytes: Buffer.from("x"),
      fileName: "a.m4a",
      contentType: "audio/mp4",
      fetchFn,
    }).catch((e) => e);
    expect(isRetryableAsrError(error)).toBe(false);
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

  // 线上就是这种形状：只有 code，没有 message，旧版原样拼成「失败：code=SERVER_ERROR」，
  // 看不出到底是「对象存储在内网」还是「音频里没人声」。code 要单独透出来给上层翻译。
  it("FAILED 只有 code 时也要单独透出", async () => {
    const fetchFn = mockFetch(() => jsonResponse(200, {
      output: { task_status: "FAILED", code: "ASR_RESPONSE_HAVE_NO_WORDS" },
    }));
    const job = await pollTranscriptionStatus({ config: CONFIG, taskId: "t", fetchFn });
    expect(job.status).toBe("FAILED");
    expect(job.code).toBe("ASR_RESPONSE_HAVE_NO_WORDS");
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
