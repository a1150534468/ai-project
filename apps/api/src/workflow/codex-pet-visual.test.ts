import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ImageBinaryInput } from "./image-service.js";
import { generateCodexPetVisual } from "./codex-pet-visual.js";

async function reference(index: number): Promise<ImageBinaryInput> {
  const buffer = await sharp({
    create: {
      width: 96 + index,
      height: 80 + index,
      channels: 4,
      background: { r: 30 * index, g: 80, b: 180, alpha: 1 },
    },
  }).png().toBuffer();
  return {
    b64: buffer.toString("base64"),
    mime: "image/png",
    filename: `reference-${index}.png`,
  };
}

describe("Codex pet visual generation", () => {
  it.each([4, 5])(
    "compacts %i direction guidance images into at most three GPT edits parts",
    async (referenceCount) => {
      const output = await sharp({
        create: { width: 64, height: 64, channels: 4, background: "#ff00ff" },
      }).png().toBuffer();
      let uploadedParts: FormDataEntryValue[] = [];
      const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init!.body as FormData;
        uploadedParts = form.getAll("image[]");
        return new Response(JSON.stringify({
          model: "gpt-image-2-codex",
          size: "1536x1024",
          quality: "auto",
          data: [{ b64_json: output.toString("base64"), mime_type: "image/png" }],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            total_tokens: 30,
            input_tokens_details: { image_tokens: 8, text_tokens: 2 },
            output_tokens_details: { image_tokens: 20 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      await generateCodexPetVisual({
        prompt: "Generate a registered 4x2 Codex pet direction board.",
        references: await Promise.all(Array.from({ length: referenceCount }, (_, index) => reference(index + 1))),
        size: "1536x1024",
        quality: "low",
        fetchFn: fetchFn as typeof fetch,
        env: {
          GPT_IMAGE_API_KEY: "test-key",
          GPT_IMAGE_GENERATION_ENDPOINT: "https://images.example.test/v1/images/generations",
          GPT_IMAGE_EDIT_ENDPOINT: "https://images.example.test/v1/images/edits",
        },
      });

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(uploadedParts).toHaveLength(3);
      const merged = uploadedParts.at(-1);
      expect(merged).toBeInstanceOf(Blob);
      const mergedBytes = Buffer.from(await (merged as Blob).arrayBuffer());
      const metadata = await sharp(mergedBytes).metadata();
      expect(metadata.format).toBe("png");
      expect(metadata.width).toBe(1_536);
      expect(metadata.height).toBe(referenceCount === 4 ? 768 : 1_536);
    },
  );
});
