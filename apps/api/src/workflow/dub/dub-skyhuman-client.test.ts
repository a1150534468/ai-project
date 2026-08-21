import { describe, it, expect, vi } from "vitest";
import {
  loadSkyhumanConfig, createUploadUrl, createAvatarByVideo, getAvatarTask,
  createVideoByAudio, getVideoTask, getCredit, mapSkyStatus,
} from "./dub-skyhuman-client.js";

const cfg = { apiKey: "t", baseUrl: "https://sky.test" };
function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dub-skyhuman-client", () => {
  it("mapSkyStatus 归一飞天 int 状态", () => {
    expect(mapSkyStatus(1)).toBe("running");
    expect(mapSkyStatus(2)).toBe("running");
    expect(mapSkyStatus(3)).toBe("completed");
    expect(mapSkyStatus(4)).toBe("failed");
  });

  it("createUploadUrl 解出 fileId/uploadUrl/contentType", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, data: { upload_url: "https://oss/x", content_type: "video/mp4", file_id: "file_1" } }));
    const r = await createUploadUrl(cfg, fetchFn, "mp4");
    expect(r).toEqual({ uploadUrl: "https://oss/x", contentType: "video/mp4", fileId: "file_1" });
  });

  it("createAvatarByVideo 返回 taskId", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, task_id: "task_9" }));
    const r = await createAvatarByVideo(cfg, fetchFn, { title: "a", fileId: "file_1" });
    expect(r.taskId).toBe("task_9");
  });

  // 飞天在 等待中/处理中 时返回 avatar:null、video_url:null —— zod 的 .optional() 只收 undefined 不收 null，
  // 曾导致第一次轮询就抛 ZodError、克隆/成片必失败。锁死这个行为。
  it("getAvatarTask 处理中：avatar 为 null 不抛错，status=running", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, message: null, status: 2, avatar: null }));
    const r = await getAvatarTask(cfg, fetchFn, "task_9");
    expect(r).toEqual({ status: "running" });
  });

  it("getVideoTask 处理中：video_url/duration/cost 均为 null 不抛错", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: 1, video_url: null, duration: null, cost: null }));
    const r = await getVideoTask(cfg, fetchFn, "task_9");
    expect(r).toEqual({ status: "running" });
  });

  it("飞天响应结构异常时抛 SkyhumanError（而非泄漏 ZodError JSON 给用户）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: "不是数字" }));
    await expect(getAvatarTask(cfg, fetchFn, "t")).rejects.toMatchObject({ name: "SkyhumanError" });
  });

  it("上游类型不严谨也不挂：数字型 task_id、字符串型 status 均能收敛", async () => {
    const f1 = vi.fn().mockResolvedValue(jsonRes({ code: 0, task_id: 1234567890123456 }));
    expect((await createAvatarByVideo(cfg, f1, { title: "a", fileId: "f" })).taskId).toBe("1234567890123456");
    const f2 = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: "3", avatar: "av_x" }));
    expect(await getAvatarTask(cfg, f2, "t")).toEqual({ status: "completed", avatarCode: "av_x" });
  });

  it("失败时透出飞天的真实原因（code 仍为 0，原因只在 message）", async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: 4, avatar: null, message: "视频中未检测到人脸" }));
    expect(await getAvatarTask(cfg, f, "t")).toEqual({ status: "failed", message: "视频中未检测到人脸" });
  });

  it("getAvatarTask 完成时带 avatarCode", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: 3, avatar: "av_abc" }));
    const r = await getAvatarTask(cfg, fetchFn, "task_9");
    expect(r).toMatchObject({ status: "completed", avatarCode: "av_abc" });
  });

  it("getVideoTask 完成时带 videoUrl/duration/cost", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, status: 3, video_url: "https://v/1.mp4", duration: 45, cost: 450 }));
    const r = await getVideoTask(cfg, fetchFn, "task_9");
    expect(r).toMatchObject({ status: "completed", videoUrl: "https://v/1.mp4", duration: 45, cost: 450 });
  });

  it("getCredit 返回 left", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 0, left: 10000 }));
    const r = await getCredit(cfg, fetchFn);
    expect(r.left).toBe(10000);
  });

  it("业务错误码抛 SkyhumanError 带 code（1002 积分不足）", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonRes({ code: 1002, message: "积分不足" }));
    await expect(createVideoByAudio(cfg, fetchFn, { avatar: "av_1", fileId: "file_a", title: "t" }))
      .rejects.toMatchObject({ name: "SkyhumanError", code: 1002 });
  });

  it("401 抛 SkyhumanError code=2003", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(getCredit(cfg, fetchFn)).rejects.toMatchObject({ name: "SkyhumanError", code: 2003 });
  });

  it("loadSkyhumanConfig 缺 token 抛错", () => {
    expect(() => loadSkyhumanConfig({} as NodeJS.ProcessEnv)).toThrow(/SKYHUMAN_API_TOKEN/);
  });

  it("loadSkyhumanConfig 默认 baseUrl 去尾斜杠", () => {
    const c = loadSkyhumanConfig({ SKYHUMAN_API_TOKEN: "tok", SKYHUMAN_BASE_URL: "https://x.com/" } as unknown as NodeJS.ProcessEnv);
    expect(c).toEqual({ apiKey: "tok", baseUrl: "https://x.com" });
  });
});
