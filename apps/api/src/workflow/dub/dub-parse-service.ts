import { extractShareUrl } from "./dub-share-url.js";
import { parseShareUrl, type ParseConfig, type ParsedShare } from "./dub-parse-client.js";
import { fetchRemoteToBuffer } from "../_shared/safe-fetch.js";
import { probeVideoDurationSec } from "../_shared/video-probe.js";
import { DUB_PARSE_VIDEO_KEY, DUB_PARSE_VIDEO_MAX_BYTES, DUB_PARSE_COVER_MAX_BYTES, DUB_PARSE_TIMEOUT_MS } from "./dub-constants.js";
import { loadS3Config, makeS3, putObject } from "../../storage/s3.js";
import { buildAudioPublicUrl } from "./dub-audio-store.js";
import { randomUUID } from "node:crypto";

export interface DubParseResult {
  title: string;
  cover: { url: string };
  video: { url: string; objectKey: string; durationSec: number; sizeBytes: number };
  chargedPoints: number;
}

interface ParseBilling {
  chargeResource: (a: { operationId: string; userId: string; resourceKey: string; units: number; accountType: "points" | "video" }) => Promise<{ charged: number }>;
  refundResource: (operationId: string) => Promise<{ success: boolean }>;
}

type StoreFn = (a: { userId: string; buffer: Buffer; mime: string; ext: string }) => Promise<{ url: string; objectKey: string }>;

export interface ParseServiceDeps {
  billing: ParseBilling;
  parseConfig: ParseConfig;
  parseShareUrlFn?: (cfg: ParseConfig, url: string) => Promise<ParsedShare>;
  fetchRemoteFn?: typeof fetchRemoteToBuffer;
  probeDurationSec?: (b: Buffer) => Promise<number>;
  storeToS3?: StoreFn;
  onError?: (msg: string, err: unknown) => void; // 可选：记录退款失败等，不改变抛出的原始错误
}

const defaultStore: StoreFn = async (a) => {
  const cfg = loadS3Config();
  const s3 = makeS3(cfg);
  const key = `dub/parsed/${a.userId}/${randomUUID()}.${a.ext}`;
  await putObject(s3, key, a.buffer, a.mime, { acl: "public-read" });
  return { url: buildAudioPublicUrl(cfg, key), objectKey: key };
};

export async function parseShareToStored(input: {
  userId: string; requestId: string; text: string; deps: ParseServiceDeps;
}): Promise<DubParseResult> {
  const { userId, requestId, deps } = input;
  const url = extractShareUrl(input.text);
  if (!url) throw new Error("未识别到有效链接，请粘贴完整分享文案");

  const parse = deps.parseShareUrlFn ?? ((cfg, u) => parseShareUrl(cfg, u));
  const download = deps.fetchRemoteFn ?? fetchRemoteToBuffer;
  const probe = deps.probeDurationSec ?? probeVideoDurationSec;
  const store = deps.storeToS3 ?? defaultStore;

  const operationId = `dub-parse:${requestId}`;
  const { charged } = await deps.billing.chargeResource({ operationId, userId, resourceKey: DUB_PARSE_VIDEO_KEY, units: 1, accountType: "points" });
  try {
    const parsed = await parse(deps.parseConfig, url);
    if (parsed.kind !== "video" || !parsed.playAddr) throw new Error("该链接为图文/图集，暂不支持拆解，请换视频链接");

    const vid = await download(parsed.playAddr, { maxBytes: DUB_PARSE_VIDEO_MAX_BYTES, timeoutMs: DUB_PARSE_TIMEOUT_MS });
    const durationSec = await probe(vid.buffer);
    if (durationSec <= 0) throw new Error("解析结果不是有效视频");

    const videoStored = await store({ userId, buffer: vid.buffer, mime: "video/mp4", ext: "mp4" });

    let coverUrl = "";
    if (parsed.cover) {
      try {
        const cov = await download(parsed.cover, { maxBytes: DUB_PARSE_COVER_MAX_BYTES, timeoutMs: DUB_PARSE_TIMEOUT_MS });
        const coverStored = await store({ userId, buffer: cov.buffer, mime: cov.mime || "image/jpeg", ext: "jpg" });
        coverUrl = coverStored.url;
      } catch { coverUrl = ""; } // 封面失败不阻断主流程
    }

    return {
      title: parsed.desc,
      cover: { url: coverUrl },
      video: { url: videoStored.url, objectKey: videoStored.objectKey, durationSec: Math.ceil(durationSec), sizeBytes: vid.buffer.byteLength },
      chargedPoints: charged,
    };
  } catch (err) {
    // 退款失败必须可观测（钱的问题），但仍抛原始错误以便上层做错误码映射。
    try {
      await deps.billing.refundResource(operationId);
    } catch (refundErr) {
      deps.onError?.("dub-parse 退款失败", refundErr);
    }
    throw err;
  }
}
