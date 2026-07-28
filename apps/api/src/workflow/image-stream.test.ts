import { describe, expect, it } from "vitest";
import { readImageStream } from "./image-stream.js";

function sseResponse(lines: readonly string[], chunkSize = 1024): Response {
  const text = lines.join("\n");
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const b64 = Buffer.from("final-image").toString("base64");
const partialB64 = Buffer.from("partial").toString("base64");

describe("readImageStream", () => {
  it("returns the completed image and ignores keepalive partials", async () => {
    const result = await readImageStream(sseResponse([
      `data: {"type":"image_edit.partial_image","b64_json":"${partialB64}"}`,
      `data: {"type":"image_edit.partial_image","b64_json":"${partialB64}"}`,
      `data: {"type":"image_edit.completed","b64_json":"${b64}","model":"gpt-image-2","usage":{"total_tokens":7}}`,
      "data: [DONE]",
      "",
    ]));
    expect(result.partialCount).toBe(2);
    expect(result.payload).toEqual({ data: [{ b64_json: b64 }], model: "gpt-image-2", usage: { total_tokens: 7 } });
  });

  it("handles generation event names too", async () => {
    const result = await readImageStream(sseResponse([
      `data: {"type":"image_generation.partial_image","b64_json":"${partialB64}"}`,
      `data: {"type":"image_generation.completed","b64_json":"${b64}"}`,
      "",
    ]));
    expect(result.partialCount).toBe(1);
    expect(result.payload).toEqual({ data: [{ b64_json: b64 }] });
  });

  it("accepts a relay that nests the completed image under data[]", async () => {
    const result = await readImageStream(sseResponse([
      `data: {"type":"image_edit.completed","data":[{"b64_json":"${b64}"}]}`,
      "",
    ]));
    expect(result.payload).toEqual({ data: [{ b64_json: b64 }] });
  });

  it("reassembles events split across chunk boundaries", async () => {
    const result = await readImageStream(sseResponse([
      `data: {"type":"image_edit.completed","b64_json":"${b64}"}`,
      "",
    ], 7));
    expect(result.payload).toEqual({ data: [{ b64_json: b64 }] });
  });

  it("skips heartbeats and unparsable lines", async () => {
    const result = await readImageStream(sseResponse([
      ": keepalive",
      "event: ping",
      "data: not-json",
      `data: {"type":"image_edit.completed","b64_json":"${b64}"}`,
      "",
    ]));
    expect(result.payload).toEqual({ data: [{ b64_json: b64 }] });
  });

  it("falls back to the last partial when the stream ends without completed", async () => {
    const result = await readImageStream(sseResponse([
      `data: {"type":"image_edit.partial_image","b64_json":"${partialB64}"}`,
      "",
    ]));
    expect(result.payload).toEqual({ data: [{ b64_json: partialB64 }] });
  });

  it("throws the upstream message when the stream reports an error", async () => {
    await expect(readImageStream(sseResponse([
      `data: {"error":{"message":"content policy violation"}}`,
      "",
    ]))).rejects.toThrow("content policy violation");
  });

  it("throws when the stream ends with no image at all", async () => {
    await expect(readImageStream(sseResponse(["data: [DONE]", ""])))
      .rejects.toThrow("image stream ended without a generated image");
  });

  it("throws when the response has no body", async () => {
    const response = new Response(null, { headers: { "content-type": "text/event-stream" } });
    await expect(readImageStream(response)).rejects.toThrow("image stream response has no body");
  });
});
