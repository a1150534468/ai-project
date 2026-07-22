import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortraitTask, deletePortraitReference, getPortraitState } from "./portraitApi";

afterEach(() => vi.unstubAllGlobals());

describe("portrait api", () => {
  it("loads state with bearer auth and unwraps the API data envelope", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { references: [], tasks: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPortraitState("token-1")).resolves.toEqual({ references: [], tasks: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/workflow/portraits/state", expect.objectContaining({ method: "GET", headers: { authorization: "Bearer token-1" } }));
  });

  it("submits consent and uses dedicated portrait delete routes", async () => {
    const task = { id: "task-1", requestId: "portrait-request-1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { task } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const payload = {
      requestId: "portrait-request-1",
      presetId: "business" as const,
      aspectRatio: "3:4" as const,
      resolution: "2K" as const,
      count: 1,
      referenceAssetIds: ["ref-1"],
      options: { scene: "影棚", outfit: "西装", composition: "半身", expression: "微笑", hair: "", makeup: "", extraPrompt: "" },
      authorizationAccepted: true as const,
      consentVersion: "portrait-consent-v1",
    };
    await createPortraitTask("token-2", payload);
    await deletePortraitReference("token-2", "ref / 1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workflow/portraits/generate");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(payload);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/workflow/portraits/references/ref%20%2F%201");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
