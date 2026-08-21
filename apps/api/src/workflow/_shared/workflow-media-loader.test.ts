import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getObjectMock, getObjectToFileMock, loadS3ConfigMock, makeS3Mock } = vi.hoisted(() => ({
  getObjectMock: vi.fn(),
  getObjectToFileMock: vi.fn(),
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

vi.mock("../../storage/s3.js", () => ({
  getObject: getObjectMock,
  getObjectToFile: getObjectToFileMock,
  loadS3Config: loadS3ConfigMock,
  makeS3: makeS3Mock,
}));

import { loadWorkflowMediaBuffer, loadWorkflowMediaFile } from "./workflow-media-loader.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadWorkflowMediaFile", () => {
  it("streams an HTTP response to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-media-file-"));
    const outputPath = join(dir, "material.mp4");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchFn = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": String(bytes.byteLength) },
        }),
    );
    try {
      const loaded = await loadWorkflowMediaFile({
        source: { url: "https://example.test/material.mp4", mime: "video/mp4" },
        outputPath,
        fetchFn: fetchFn as unknown as typeof fetch,
        maxBytes: 10,
      });
      expect(loaded.bytes).toBe(4);
      expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects Content-Length before writing an oversized response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-media-limit-"));
    const outputPath = join(dir, "material.mp4");
    const fetchFn = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": "100" },
        }),
    );
    try {
      await expect(
        loadWorkflowMediaFile({
          source: { url: "https://example.test/material.mp4", mime: "video/mp4" },
          outputPath,
          fetchFn: fetchFn as unknown as typeof fetch,
          maxBytes: 10,
        }),
      ).rejects.toThrow(/10/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a partial HTTP download when Content-Length does not match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-media-mismatch-"));
    const outputPath = join(dir, "material.mp4");
    const fetchFn = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "10" },
        }),
    );
    try {
      await expect(
        loadWorkflowMediaFile({
          source: { url: "https://example.test/material.mp4", mime: "video/mp4" },
          outputPath,
          fetchFn: fetchFn as unknown as typeof fetch,
          maxBytes: 20,
        }),
      ).rejects.toThrow("素材长度不匹配");
      await expect(access(outputPath)).rejects.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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

    await expect(
      loadWorkflowMediaBuffer({
        source: {
          url: "http://169.254.169.254/latest/meta-data",
          mime: "text/plain",
          objectKey: "workflow/video-materials/u1/missing.txt",
        },
        fetchFn: fetchFn as unknown as typeof fetch,
        allowUrlFallback: false,
      }),
    ).rejects.toThrow("拉取素材失败");

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
