import { afterEach, describe, expect, it, vi } from "vitest";

const { getObjectMock, loadS3ConfigMock, makeS3Mock } = vi.hoisted(() => ({
  getObjectMock: vi.fn(),
  loadS3ConfigMock: vi.fn(() => ({
    endpoint: "http://s3.test",
    region: "us-east-1",
    bucket: "test-bucket",
    accessKey: "key",
    secretKey: "secret",
    forcePathStyle: true,
  })),
  makeS3Mock: vi.fn(() => ({
    client: {},
    bucket: "test-bucket",
  })),
}));

vi.mock("../storage/s3.js", () => ({
  getObject: getObjectMock,
  loadS3Config: loadS3ConfigMock,
  makeS3: makeS3Mock,
}));

import { loadWorkflowMediaBuffer } from "./workflow-media-loader.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadWorkflowMediaBuffer", () => {
  it("prefers object storage when objectKey is present", async () => {
    getObjectMock.mockResolvedValue(Buffer.from([7, 8, 9]));
    const fetchFn = vi.fn();

    const loaded = await loadWorkflowMediaBuffer({
      source: {
        url: "http://localhost:9000/test-bucket/private.mp4",
        mime: "video/mp4",
        objectKey: "workflow/video-materials/u1/private.mp4",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(getObjectMock).toHaveBeenCalledWith(expect.anything(), "workflow/video-materials/u1/private.mp4");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(loaded).toEqual({
      mime: "video/mp4",
      buffer: Buffer.from([7, 8, 9]),
    });
  });

  it("falls back to fetch when object storage read fails", async () => {
    getObjectMock.mockRejectedValue(new Error("AccessDenied"));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    const loaded = await loadWorkflowMediaBuffer({
      source: {
        url: "https://example.test/material.jpg",
        mime: "image/jpeg",
        objectKey: "workflow/video-materials/u1/material.jpg",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(fetchFn).toHaveBeenCalledWith("https://example.test/material.jpg");
    expect(loaded).toEqual({
      mime: "image/jpeg",
      buffer: Buffer.from([1, 2, 3]),
    });
  });

  it("does not fall back to fetch when url fallback is disabled", async () => {
    getObjectMock.mockRejectedValue(new Error("NoSuchKey"));
    const fetchFn = vi.fn();

    await expect(loadWorkflowMediaBuffer({
      source: {
        url: "http://169.254.169.254/latest/meta-data",
        mime: "text/plain",
        objectKey: "workflow/video-materials/u1/missing.txt",
      },
      fetchFn: fetchFn as unknown as typeof fetch,
      allowUrlFallback: false,
    })).rejects.toThrow("拉取素材失败");

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
