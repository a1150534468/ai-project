import { Buffer } from "node:buffer";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getObject, loadS3Config, makeS3 } from "../../storage/s3.js";
import {
  MIMO_TTS_PRESET_MODEL,
  MIMO_TTS_VOICE_CLONE_MODEL,
  MIMO_TTS_VOICE_DESIGN_MODEL,
  encodeVoiceCloneSample,
  storeWorkflowAudio,
  synthesizeMimoSpeech,
  type LocalBusinessPromoAudioKind,
} from "./audio-service.js";
import {
  countLocalBusinessPromoSpeechChars,
  localBusinessPromoNarrationBudget,
  narrationVoiceProviderId,
  normalizeSettings,
  type LocalBusinessPromoSettings,
} from "./local-business-promo-core.js";
import { createTransientAudioAsset } from "./local-business-promo-route-helpers.js";
import {
  LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT,
  PRESET_NARRATION_PREVIEW_CACHE_VERSION,
  type AudioAssetRow,
  type NarrationVoice,
  type ProjectRow,
} from "./local-business-promo-route-types.js";

async function loadVoiceCloneSampleDataUrl(args: {
  readonly asset: NonNullable<AudioAssetRow>;
  readonly fetchFn: typeof fetch;
}): Promise<string> {
  if (args.asset.originalUrl.startsWith("data:")) return args.asset.originalUrl;
  let buffer: Buffer | null = null;
  if (args.asset.objectKey) {
    try {
      buffer = await getObject(makeS3(loadS3Config()), args.asset.objectKey);
    } catch {
      buffer = null;
    }
  }
  if (!buffer) {
    const response = await args.fetchFn(args.asset.originalUrl, { method: "GET" });
    if (!response.ok) throw new Error(`音色样本下载失败：${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  }
  return encodeVoiceCloneSample({
    buffer,
    mime: args.asset.mime,
  });
}

export async function createProjectAudioAsset(args: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly projectId: string;
  readonly kind: LocalBusinessPromoAudioKind;
  readonly source: string;
  readonly provider?: string | null;
  readonly providerModel?: string | null;
  readonly requestId?: string | null;
  readonly filename: string;
  readonly mime: string;
  readonly buffer: Buffer;
  readonly textContent?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}): Promise<NonNullable<AudioAssetRow>> {
  const stored = await storeWorkflowAudio({
    userId: args.userId,
    filename: args.filename,
    mime: args.mime,
    buffer: args.buffer,
    folder: `workflow/audio/${args.userId}/${args.projectId}/${args.kind}`,
  });
  return args.prisma.audioAsset.create({
    data: {
      userId: args.userId,
      projectId: args.projectId,
      requestId: args.requestId ?? null,
      kind: args.kind,
      source: args.source,
      provider: args.provider ?? null,
      providerModel: args.providerModel ?? null,
      originalUrl: stored.url,
      objectKey: stored.objectKey,
      mime: stored.mime,
      format: stored.format,
      durationSec: stored.durationSec,
      textContent: args.textContent ?? null,
      metadata: args.metadata === null ? Prisma.JsonNull : args.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export function ensureNarrationText(project: ProjectRow): string {
  const text = (project.scriptDraft ?? "").trim();
  if (!text) throw new Error("请先生成或填写口播文案");
  const settings = normalizeSettings(project.settings);
  const budget = localBusinessPromoNarrationBudget(settings.durationSec);
  const totalChars = countLocalBusinessPromoSpeechChars(text);
  if (totalChars > budget.totalMaxChars) {
    throw new Error(
      `当前口播文案偏长，${settings.durationSec} 秒版本建议控制在 ${budget.totalMaxChars} 字以内，成片最多只会顺延到 ${budget.maxDurationSec} 秒左右，请先精简或重新生成文案`,
    );
  }
  return text;
}

export async function resolveNarrationGenerationInput(args: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly project: ProjectRow;
  readonly fetchFn: typeof fetch;
  readonly text: string;
}): Promise<{
  readonly voiceMode: LocalBusinessPromoSettings["voiceMode"];
  readonly model: typeof MIMO_TTS_PRESET_MODEL | typeof MIMO_TTS_VOICE_DESIGN_MODEL | typeof MIMO_TTS_VOICE_CLONE_MODEL;
  readonly narrationVoice?: LocalBusinessPromoSettings["narrationVoice"];
  readonly presetVoiceId?: string;
  readonly text: string;
  readonly voiceDesignPrompt?: string;
  readonly voiceStylePrompt?: string;
  readonly voiceSampleDataUrl?: string;
  readonly sampleAssetId?: string | null;
}> {
  const settings = normalizeSettings(args.project.settings);
  if (settings.voiceMode === "preset") {
    return {
      voiceMode: settings.voiceMode,
      model: MIMO_TTS_PRESET_MODEL,
      narrationVoice: settings.narrationVoice,
      presetVoiceId: narrationVoiceProviderId(settings.narrationVoice),
      text: args.text,
      sampleAssetId: null,
    };
  }
  if (settings.voiceMode === "clone") {
    if (!args.project.voiceCloneSampleAssetId) {
      throw new Error("请先上传音色复刻样本");
    }
    const sampleAsset = await args.prisma.audioAsset.findFirst({
      where: {
        id: args.project.voiceCloneSampleAssetId,
        userId: args.userId,
        projectId: args.project.id,
        kind: "voice-sample",
      },
    });
    if (!sampleAsset) {
      throw new Error("当前项目的音色复刻样本不存在");
    }
    return {
      voiceMode: settings.voiceMode,
      model: MIMO_TTS_VOICE_CLONE_MODEL,
      text: args.text,
      voiceSampleDataUrl: await loadVoiceCloneSampleDataUrl({ asset: sampleAsset, fetchFn: args.fetchFn }),
      sampleAssetId: sampleAsset.id,
    };
  }
  if (!settings.voiceDesignPrompt.trim()) {
    throw new Error("请先填写音色描述");
  }
  return {
    voiceMode: settings.voiceMode,
    model: MIMO_TTS_VOICE_DESIGN_MODEL,
    text: args.text,
    voiceDesignPrompt: settings.voiceDesignPrompt,
    voiceStylePrompt: settings.voiceStylePrompt,
    sampleAssetId: null,
  };
}

export function buildNarrationAudioMetadata(
  input: Awaited<ReturnType<typeof resolveNarrationGenerationInput>>,
): Record<string, unknown> {
  return {
    voiceMode: input.voiceMode,
    narrationVoice: input.voiceMode === "preset" ? input.narrationVoice ?? null : null,
    presetVoiceId: input.voiceMode === "preset" ? input.presetVoiceId ?? null : null,
    voiceDesignPrompt: input.voiceMode === "design" ? input.voiceDesignPrompt ?? null : null,
    voiceStylePrompt: input.voiceMode === "design" ? input.voiceStylePrompt ?? null : null,
    sampleAssetId: input.voiceMode === "clone" ? input.sampleAssetId ?? null : null,
  };
}

function presetNarrationPreviewRequestId(voice: NarrationVoice): string {
  return `local-business-promo:preset-preview:${PRESET_NARRATION_PREVIEW_CACHE_VERSION}:${voice}`;
}

export async function findOrCreatePresetNarrationPreviewAsset(args: {
  readonly prisma: PrismaClient;
  readonly userId: string;
  readonly fetchFn: typeof fetch;
  readonly narrationVoice: NarrationVoice;
}): Promise<NonNullable<AudioAssetRow>> {
  const requestId = presetNarrationPreviewRequestId(args.narrationVoice);
  const cached = await args.prisma.audioAsset.findFirst({
    where: {
      userId: args.userId,
      requestId,
      kind: "narration",
    },
  });
  if (cached) return cached;

  const presetVoiceId = narrationVoiceProviderId(args.narrationVoice);
  const audio = await synthesizeMimoSpeech({
    fetchFn: args.fetchFn,
    model: MIMO_TTS_PRESET_MODEL,
    text: LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT,
    presetVoiceId,
  });
  const stored = await storeWorkflowAudio({
    userId: args.userId,
    filename: `narration-preview-${args.narrationVoice}.wav`,
    mime: audio.mime,
    buffer: audio.buffer,
    folder: `workflow/audio/${args.userId}/preset-narration-preview`,
  });
  return args.prisma.audioAsset.create({
    data: {
      userId: args.userId,
      projectId: null,
      requestId,
      kind: "narration",
      source: "mimo-tts",
      provider: "mimo",
      providerModel: MIMO_TTS_PRESET_MODEL,
      originalUrl: stored.url,
      objectKey: stored.objectKey,
      mime: stored.mime,
      format: stored.format,
      durationSec: stored.durationSec,
      textContent: LOCAL_BUSINESS_PROMO_AUDIO_PREVIEW_TEXT,
      metadata: {
        preview: true,
        presetPreview: true,
        voiceMode: "preset",
        narrationVoice: args.narrationVoice,
        presetVoiceId,
        voiceDesignPrompt: null,
        voiceStylePrompt: null,
        sampleAssetId: null,
      } as Prisma.InputJsonValue,
    },
  });
}

export { createTransientAudioAsset };
