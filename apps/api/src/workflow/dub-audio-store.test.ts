import { describe, it, expect } from "vitest";
import { buildAudioPublicUrl } from "./dub-audio-store.js";

describe("dub-audio-store", () => {
  it("forcePathStyle 时 URL = endpoint/bucket/key", () => {
    const url = buildAudioPublicUrl({ endpoint: "http://minio:9000", bucket: "yc", forcePathStyle: true } as any, "dub/audio/u1/x.wav", {} as NodeJS.ProcessEnv);
    expect(url).toBe("http://minio:9000/yc/dub/audio/u1/x.wav");
  });
  it("配置了 S3_PUBLIC_BASE_URL 时优先用它", () => {
    const url = buildAudioPublicUrl({ endpoint: "http://minio:9000", bucket: "yc", forcePathStyle: true } as any, "dub/audio/u1/x.wav", { S3_PUBLIC_BASE_URL: "https://cdn.example.com" } as unknown as NodeJS.ProcessEnv);
    expect(url).toBe("https://cdn.example.com/dub/audio/u1/x.wav");
  });
});
