import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeAudioDurationSec } = vi.hoisted(() => ({
  probeAudioDurationSec: vi.fn(async () => 7),
}));

vi.mock("./audio-probe.js", () => ({
  probeAudioDurationSec,
}));

import {
  MIMO_TTS_PRESET_MODEL,
  MIMO_TTS_VOICE_CLONE_MODEL,
  MIMO_TTS_VOICE_DESIGN_MODEL,
  buildMimoSpeechRequest,
  encodeVoiceCloneSample,
  ensureLocalBusinessPromoBgmLibrary,
  loadLocalBusinessPromoBgmBinary,
  localBusinessPromoBgmPresetFile,
  synthesizeMimoSpeech,
  validateUploadedBgmFile,
  validateVoiceCloneSampleFile,
} from "./audio-service.js";

describe("audio service", () => {
  beforeEach(() => {
    probeAudioDurationSec.mockClear();
    probeAudioDurationSec.mockResolvedValue(7);
  });

  it("builds voicedesign request with user instruction and assistant text", () => {
    expect(buildMimoSpeechRequest({
      model: MIMO_TTS_VOICE_DESIGN_MODEL,
      text: "欢迎来到门店",
      voiceDesignPrompt: "一位自然亲切的年轻女性，普通话清晰。",
      voiceStylePrompt: "语速自然可信。",
    })).toEqual({
      model: MIMO_TTS_VOICE_DESIGN_MODEL,
      messages: [
        { role: "user", content: "一位自然亲切的年轻女性，普通话清晰。\n播报风格：语速自然可信。" },
        { role: "assistant", content: "欢迎来到门店" },
      ],
      audio: { format: "wav" },
    });
  });

  it("builds voiceclone request without empty user message", () => {
    expect(buildMimoSpeechRequest({
      model: MIMO_TTS_VOICE_CLONE_MODEL,
      text: "欢迎来到门店",
      voiceSampleDataUrl: "data:audio/wav;base64,ZmFrZQ==",
    })).toEqual({
      model: MIMO_TTS_VOICE_CLONE_MODEL,
      messages: [{ role: "assistant", content: "欢迎来到门店" }],
      audio: {
        format: "wav",
        voice: "data:audio/wav;base64,ZmFrZQ==",
      },
    });
  });

  it("builds preset-voice preview request with a direct voice id", () => {
    expect(buildMimoSpeechRequest({
      model: MIMO_TTS_PRESET_MODEL,
      text: "欢迎来到门店",
      presetVoiceId: "冰糖",
    })).toEqual({
      model: MIMO_TTS_PRESET_MODEL,
      messages: [{ role: "assistant", content: "欢迎来到门店" }],
      audio: {
        format: "wav",
        voice: "冰糖",
      },
    });
  });

  it("validates voice clone samples and rejects oversize or wrong mime", async () => {
    expect(() => encodeVoiceCloneSample({
      buffer: Buffer.from("bad"),
      mime: "audio/ogg",
    })).toThrow("仅支持 mp3/wav/m4a 音色样本");

    await expect(validateVoiceCloneSampleFile({
      filename: "sample.wav",
      mime: "audio/wav",
      buffer: Buffer.from("fake wav"),
    })).resolves.toEqual({
      mime: "audio/wav",
      durationSec: 7,
    });

    await expect(validateVoiceCloneSampleFile({
      filename: "sample.m4a",
      mime: "audio/x-m4a",
      buffer: Buffer.from("fake m4a"),
    })).resolves.toEqual({
      mime: "audio/mp4",
      durationSec: 7,
    });

    expect(encodeVoiceCloneSample({
      buffer: Buffer.from("fake m4a"),
      mime: "audio/x-m4a",
    })).toContain("data:audio/mp4;base64,");

    expect(() => encodeVoiceCloneSample({
      buffer: Buffer.alloc(8 * 1024 * 1024),
      mime: "audio/wav",
    })).toThrow("音色样本 Base64 编码后不能超过 10MB");
  });

  it("maps local bgm presets and supports no-bgm", async () => {
    await expect(ensureLocalBusinessPromoBgmLibrary()).resolves.toBeUndefined();
    expect(localBusinessPromoBgmPresetFile("no-bgm")).toBeNull();
    expect(localBusinessPromoBgmPresetFile("city-lively")?.filename).toBe("city-lively.mp3");
    const binary = await loadLocalBusinessPromoBgmBinary("warm-healing");
    expect(binary?.mime).toBe("audio/mpeg");
    expect(binary?.format).toBe("mp3");
  });

  it("validates uploaded bgm files", async () => {
    await expect(validateUploadedBgmFile({
      filename: "custom-bgm.mp3",
      mime: "audio/mp3",
      buffer: Buffer.from("fake mp3"),
    })).resolves.toEqual({
      mime: "audio/mpeg",
      durationSec: 7,
    });

    await expect(validateUploadedBgmFile({
      filename: "custom-bgm.ogg",
      mime: "audio/ogg",
      buffer: Buffer.from("fake ogg"),
    })).rejects.toThrow("仅支持上传 mp3/wav 格式的 BGM");
  });

  it("calls mimo completions endpoint and decodes returned wav data", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { audio: { data: Buffer.from("wav bytes").toString("base64") } } }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await synthesizeMimoSpeech({
      fetchFn,
      env: { MIMO_API_KEY: "key", MIMO_BASE_URL: "https://api.xiaomimimo.com" } as NodeJS.ProcessEnv,
      model: MIMO_TTS_VOICE_DESIGN_MODEL,
      text: "欢迎来到门店",
      voiceDesignPrompt: "一位自然亲切的年轻女性",
      voiceStylePrompt: "语速自然可信",
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.xiaomimimo.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "api-key": "key" }),
      }),
    );
    expect(result.mime).toBe("audio/wav");
    expect(result.format).toBe("wav");
    expect(result.durationSec).toBe(7);
  });
});
