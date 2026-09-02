import { afterEach, describe, expect, it, vi } from "vitest";
import { createTryOnTask, getTryOnState, uploadTryOnReference } from "./tryOnApi";

afterEach(() => vi.unstubAllGlobals());

describe("tryOnApi", () => {
  it("loads state with bearer auth and unwraps the response", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: { references: [], tasks: [] } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getTryOnState("token")).resolves.toEqual({ references: [], tasks: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workflow/try-ons/state",
      expect.objectContaining({ headers: { authorization: "Bearer token" } }),
    );
  });

  it("preserves reference roles and conditional consent in request bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: { asset: { id: "ref-1" }, task: { id: "task-1" } } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await uploadTryOnReference("token", "garment_front", { b64: "abc", mime: "image/png" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: "garment_front",
      image: { b64: "abc" },
    });

    await createTryOnTask("token", {
      requestId: "try-on-request-1",
      model: "gpt-image-2",
      aspectRatio: "3:4",
      resolution: "2K",
      count: 1,
      garmentFrontAssetId: "front-1",
      modelAssetId: "model-1",
      description: "影棚",
      authorizationAccepted: true,
      consentVersion: "try-on-consent-v2",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      modelAssetId: "model-1",
      authorizationAccepted: true,
      consentVersion: "try-on-consent-v2",
    });
  });
});
