import { describe, it, expect } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectCannedACL } from "@aws-sdk/client-s3";
import { makeS3, loadS3Config, putObject, putObjectFile, getObject, getObjectToFile, deleteObject } from "./s3.js";

const have = !!process.env.S3_ENDPOINT;

function fakeS3() {
  const s3 = makeS3({
    endpoint: "https://s3.test",
    region: "test",
    bucket: "bucket",
    accessKey: "access-key",
    secretKey: "secret-key",
    forcePathStyle: true,
  });
  const sentCommands: { input: Record<string, unknown> }[] = [];
  Object.assign(s3.client, {
    send: async (command: { input: Record<string, unknown> }) => {
      sentCommands.push(command);
      return {};
    },
  });
  return { s3, sentCommands };
}

describe("putObject", () => {
  it("passes an explicit object ACL for public assets", async () => {
    const s3 = makeS3({
      endpoint: "https://s3.test",
      region: "test",
      bucket: "bucket",
      accessKey: "access-key",
      secretKey: "secret-key",
      forcePathStyle: true,
    });
    const sentCommands: unknown[] = [];
    Object.assign(s3.client, {
      send: async (command: unknown) => {
        sentCommands.push(command);
        return {};
      },
    });

    await putObject(s3, "images/a.png", Buffer.from("hello"), "image/png", { acl: ObjectCannedACL.public_read });

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      input: {
        Bucket: "bucket",
        Key: "images/a.png",
        ContentType: "image/png",
        ACL: ObjectCannedACL.public_read,
      },
    });
  });
});

describe("putObjectFile", () => {
  it("uses a bounded file stream with an explicit Content-Length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3-put-file-"));
    const filePath = join(dir, "final.mp4");
    const content = Buffer.from("rendered-video-bytes");
    await writeFile(filePath, content);
    try {
      const { s3, sentCommands } = fakeS3();
      await putObjectFile(s3, "videos/final.mp4", filePath, "video/mp4", { acl: ObjectCannedACL.public_read });
      expect(sentCommands).toHaveLength(1);
      const body = sentCommands[0]!.input.Body;
      expect(body).toBeInstanceOf(Readable);
      expect(sentCommands[0]!.input).toMatchObject({
        Bucket: "bucket",
        Key: "videos/final.mp4",
        ContentType: "video/mp4",
        ContentLength: content.byteLength,
        ACL: ObjectCannedACL.public_read,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("getObjectToFile", () => {
  it("streams a response to disk and verifies the declared content length", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3-get-file-"));
    const filePath = join(dir, "download.bin");
    const content = Buffer.from("streamed-object");
    try {
      const { s3 } = fakeS3();
      Object.assign(s3.client, {
        send: async () => ({
          Body: Readable.from([content]),
          ContentLength: content.byteLength,
          ContentType: "application/octet-stream",
        }),
      });
      await expect(getObjectToFile(s3, "objects/a", filePath, { maxBytes: 100 })).resolves.toEqual({
        bytes: content.byteLength,
        contentType: "application/octet-stream",
      });
      await expect(readFile(filePath)).resolves.toEqual(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a partial file when the response length does not match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3-get-file-mismatch-"));
    const filePath = join(dir, "download.bin");
    try {
      const { s3 } = fakeS3();
      Object.assign(s3.client, {
        send: async () => ({ Body: Readable.from([Buffer.from("short")]), ContentLength: 10 }),
      });
      await expect(getObjectToFile(s3, "objects/a", filePath)).rejects.toThrow("length mismatch");
      await expect(access(filePath)).rejects.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!have)("s3 往返", () => {
  it("put/get/delete", async () => {
    const s3 = makeS3(loadS3Config());
    const key = `test/${Date.now()}.txt`;
    await putObject(s3, key, Buffer.from("hello"), "text/plain");
    const buf = await getObject(s3, key);
    expect(buf.toString()).toBe("hello");
    await deleteObject(s3, key);
  });
});
