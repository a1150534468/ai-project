import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelNailTryOnTask,
  createNailTryOnTask,
  deleteNailTryOnReference,
  deleteNailTryOnTask,
  getNailTryOnOptions,
  getNailTryOnState,
  uploadNailTryOnReference,
} from "./nailTryOnApi";

afterEach(() => vi.unstubAllGlobals());

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("nailTryOnApi", () => {
  it("拉取配置与状态：带 bearer 头并脱 data 外壳", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/options")
        ? ok({ data: { model: "gpt-image-2", models: [], consentVersion: "nail-try-on-consent-v1", aspectRatios: [], resolutions: [], pricing: {}, pricingByModel: {} } })
        : ok({ data: { references: [], tasks: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getNailTryOnState("token")).resolves.toEqual({ references: [], tasks: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/nail-try-ons/state",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );

    await expect(getNailTryOnOptions("token")).resolves.toMatchObject({ model: "gpt-image-2" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/workflow/nail-try-ons/options",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );
  });

  it("上传手部与款式素材：kind 与内联图裸 b64 进 body", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({ data: { asset: { id: "hand-1" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await uploadNailTryOnReference("token", "hand", { b64: "aGFuZA==", mime: "image/jpeg" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workflow/nail-try-ons/references");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: "hand",
      image: { b64: "aGFuZA==", mime: "image/jpeg" },
    });
  });
  // @@REST@@

  it("下单：mask、授权、手部资产随请求发出，无款式图时不带 nailDesignAssetId", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({ data: { task: { id: "task-1" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await createNailTryOnTask("token", {
      requestId: "nail-try-on-1",
      model: "gpt-image-2",
      aspectRatio: "3:4",
      resolution: "2K",
      count: 1,
      handAssetId: "hand-1",
      mask: { b64: "bWFzaw==" },
      description: "法式",
      authorizationAccepted: true,
      consentVersion: "nail-try-on-consent-v1",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workflow/nail-try-ons/generate");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      handAssetId: "hand-1",
      mask: { b64: "bWFzaw==" },
      authorizationAccepted: true,
      consentVersion: "nail-try-on-consent-v1",
    });
    expect("nailDesignAssetId" in body).toBe(false);
  });

  it("取消与删除对 requestId 做 URL 编码，删除素材命中 references/:id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => ok({ data: { success: true } }));
    vi.stubGlobal("fetch", fetchMock);
    await cancelNailTryOnTask("token", "nail/try on#1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/workflow/nail-try-ons/tasks/${encodeURIComponent("nail/try on#1")}/cancel`);
    await deleteNailTryOnTask("token", "req 2");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/workflow/nail-try-ons/tasks/${encodeURIComponent("req 2")}`);
    await deleteNailTryOnReference("token", "ref/3");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/workflow/nail-try-ons/references/${encodeURIComponent("ref/3")}`);
  });
});
