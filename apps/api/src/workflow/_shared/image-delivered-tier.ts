import type { ImageResolutionLabel } from "./image-upstream-options.js";

/**
 * 按"实际交付像素"而不是"用户请求档位"来结算生图点数。
 *
 * 背景：上游（尤其是第三方中继的 gpt-image-2）会忽略我们请求的绝对像素，只按宽高比
 * 输出固定的像素预算。实测 15 张形象照：请求 2K（1728x2304 = 3.98MP）和请求 1K
 * （1152x864 = 1.00MP）交付的都是 ~1.573MP，像素完全一样，但 2K 档扣 20 点、1K 档
 * 扣 10 点——用户为同一批像素付了双倍。
 *
 * 做法：预留（reserve）仍按用户选的档位，保证余额够；拿到图之后按真实像素反查档位，
 * 用那个档位的 key 结算，差额由计费服务自动退回（wallet.settlePricedUsage）。
 * 结算档位永不高于请求档位——上游多给像素是它的事，不能反过来多收钱。
 *
 * 比硬编码"某模型最高只能 1K"更好的地方：不砍用户可选项、不需要维护模型能力表，
 * 上游哪天真能出 2K 了，计费会自己跟上。
 */

/** 从 "1728x2304" 这类尺寸串取总像素；解析不出来返回 0。 */
export function pixelsFromSize(size: string | null | undefined): number {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec((size ?? "").trim());
  if (!match) return 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width * height : 0;
}

/** 交付像素允许比档位承诺低这么多仍算达标——上游按宽高比取整会掉几个百分点。 */
export const DELIVERED_TIER_TOLERANCE = 0.92;

const TIER_ORDER: readonly ImageResolutionLabel[] = ["1K", "2K", "4K"];

/**
 * 返回应当用于结算的档位：不超过 requested，且是交付像素能撑得起的最高档。
 * 一张都没交付（deliveredPixels <= 0）时按 requested 原样返回，交给调用方走退款分支。
 */
export function deliveredImageResolution(args: {
  readonly requested: ImageResolutionLabel;
  readonly deliveredPixels: number;
  readonly pixelsForResolution: (resolution: ImageResolutionLabel) => number;
  readonly tolerance?: number;
}): ImageResolutionLabel {
  if (args.deliveredPixels <= 0) return args.requested;
  const tolerance = args.tolerance ?? DELIVERED_TIER_TOLERANCE;
  const requestedIndex = TIER_ORDER.indexOf(args.requested);
  if (requestedIndex < 0) return args.requested;
  for (let index = requestedIndex; index >= 0; index -= 1) {
    const tier = TIER_ORDER[index];
    const promised = args.pixelsForResolution(tier);
    // 档位承诺算不出来时不敢往下降，保守停在这一档。
    if (promised <= 0) return tier;
    if (args.deliveredPixels >= promised * tolerance) return tier;
  }
  return TIER_ORDER[0];
}

/** 一批图里最小的那张决定结算档位——按最差的一张算，宁可少收。 */
export function minDeliveredPixels(sizes: readonly (string | null | undefined)[]): number {
  const values = sizes.map(pixelsFromSize).filter((value) => value > 0);
  return values.length > 0 ? Math.min(...values) : 0;
}
