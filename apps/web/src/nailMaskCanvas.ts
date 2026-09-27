/**
 * 试甲台蒙版合成：纯画布/几何工具，和 React 无关，方便单测几何部分。
 *
 * 对齐是这里唯一重要的事——OpenAI images/edits 要求 mask 与 image[0] 像素尺寸完全一致，
 * 后端也会二次校验。所以手部底图与蒙版都在提交时按当前档位 `humanImageOutputSize` 渲染，
 * 用同一套 contain 变换，保证画笔坐标落到手上的同一处。
 *
 * 蒙版语义（openai）：透明(alpha=0)=重绘=指甲；不透明=保留=手。用户画笔标出的是指甲，
 * 所以合成时把画笔区域「抠透明」。
 */
import type { NailAspectRatio, NailResolution } from "./nailTryOnApi";

export interface FitRect {
  readonly dx: number;
  readonly dy: number;
  readonly dw: number;
  readonly dh: number;
}

/** 尺寸串「宽x高」→ 数字。认不出返回 null（后端换档位时不至于崩）。 */
export function parseTierSize(size: string): { readonly width: number; readonly height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** object-fit: contain 的几何：等比缩放后居中，绝不裁掉指尖。 */
export function containRect(srcW: number, srcH: number, dstW: number, dstH: number): FitRect {
  if (srcW <= 0 || srcH <= 0) return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const dw = Math.round(srcW * scale);
  const dh = Math.round(srcH * scale);
  return { dx: Math.round((dstW - dw) / 2), dy: Math.round((dstH - dh) / 2), dw, dh };
}

/** `data:image/png;base64,xxx` → `xxx`。后端只收裸 b64。 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
function createTierCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持画布，无法合成试甲图像");
  return { canvas, ctx };
}

export interface NailSubmission {
  /** 手部底图，contain 铺到档位尺寸的 JPEG（裸 b64）。 */
  readonly handB64: string;
  /** 蒙版，指甲区域透明、其余不透明的 PNG（裸 b64）。 */
  readonly maskB64: string;
}

/**
 * 提交时把「本地手部照片 + 画笔选区」渲染到目标档位尺寸。
 * `selection` 是编辑用的选区画布：画笔处不透明（任意颜色），其余透明。
 * 两者用同一档位尺寸绘制，天然对齐。
 */
export function buildNailSubmission(args: {
  readonly handImage: CanvasImageSource;
  readonly handWidth: number;
  readonly handHeight: number;
  readonly selection: HTMLCanvasElement;
  readonly tierWidth: number;
  readonly tierHeight: number;
  readonly background?: string;
}): NailSubmission {
  const hand = createTierCanvas(args.tierWidth, args.tierHeight);
  hand.ctx.fillStyle = args.background ?? "#ffffff";
  hand.ctx.fillRect(0, 0, args.tierWidth, args.tierHeight);
  const rect = containRect(args.handWidth, args.handHeight, args.tierWidth, args.tierHeight);
  hand.ctx.drawImage(args.handImage, rect.dx, rect.dy, rect.dw, rect.dh);

  const mask = createTierCanvas(args.tierWidth, args.tierHeight);
  // 底图整幅不透明=全部保留；再用 destination-out 把画笔选区抠成透明=只重绘指甲。
  mask.ctx.fillStyle = "#000000";
  mask.ctx.fillRect(0, 0, args.tierWidth, args.tierHeight);
  mask.ctx.globalCompositeOperation = "destination-out";
  mask.ctx.drawImage(args.selection, 0, 0, args.tierWidth, args.tierHeight);
  mask.ctx.globalCompositeOperation = "source-over";

  return {
    handB64: stripDataUrlPrefix(hand.canvas.toDataURL("image/jpeg", 0.92)),
    maskB64: stripDataUrlPrefix(mask.canvas.toDataURL("image/png")),
  };
}

/**
 * 档位像素尺寸表：必须与后端 `apps/api/src/workflow/_shared/human-image-options.ts`
 * 的 HUMAN_IMAGE_SIZES 逐格一致——手部底图与蒙版都按这里的尺寸提交，后端还会再校验
 * `hand 尺寸 === 档位 === mask 尺寸`。改一处务必两处同步。
 */
const HUMAN_TIER_SIZES: Readonly<Record<NailResolution, Readonly<Record<NailAspectRatio, string>>>> = {
  "1K": { "1:1": "1024x1024", "3:4": "864x1152", "4:3": "1152x864", "9:16": "800x1424", "16:9": "1424x800" },
  "2K": { "1:1": "2048x2048", "3:4": "1728x2304", "4:3": "2304x1728", "9:16": "1600x2848", "16:9": "2848x1600" },
  "4K": { "1:1": "4096x4096", "3:4": "3520x4704", "4:3": "4704x3520", "9:16": "3040x5504", "16:9": "5504x3040" },
};

/** 当前档位的目标像素尺寸；认不出档位时回落到 2K 方形，绝不返回 0。 */
export function humanTierDimensions(resolution: NailResolution, aspectRatio: NailAspectRatio): { readonly width: number; readonly height: number } {
  const size = HUMAN_TIER_SIZES[resolution]?.[aspectRatio] ?? HUMAN_TIER_SIZES["2K"]["1:1"];
  return parseTierSize(size) ?? { width: 2048, height: 2048 };
}
/**
 * 从本地文件加载成 HTMLImageElement 供编辑器绘制。手部照片是隐私主体，
 * 提交前只存在于本地：用 objectURL 载入，调用方在替换/卸载时负责 revoke(url)。
 */
export function loadImageFromFile(file: File): Promise<{ readonly image: HTMLImageElement; readonly url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取该图片，请换一张手部照片"));
    };
    image.src = url;
  });
}

