import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowEcomReference } from "./workflowEcomApi";

describe("workflow ecom API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses the existing image-workflow reference upload endpoint", async () => {
    const asset = {
      id: "ref-1",
      requestId: "ecom-reference:1",
      originalUrl: "data:image/png;base64,cG5n",
      thumbnailUrl: "data:image/png;base64,cG5n",
      mime: "image/png",
      createdAt: "2026-07-16T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { asset } }), { status: 200 }));

    await expect(createWorkflowEcomReference("token", { b64: "cG5n", mime: "image/png" })).resolves.toEqual(asset);
    expect(fetchMock).toHaveBeenCalledWith("/api/workflow/images/references", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer token" }),
    }));
  });
});
