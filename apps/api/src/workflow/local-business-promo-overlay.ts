import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type {
  LocalBusinessPromoAspectRatio,
  LocalBusinessPromoBrief,
  LocalBusinessPromoShotPlanEntry,
  LocalBusinessPromoSubtitlePlacement,
  LocalBusinessPromoSubtitleStyle,
} from "./local-business-promo-core.js";

const OVERLAY_FONT_FAMILY = "YCBusinessPromo";
const OVERLAY_FONT_PATHS = [
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Medium.ttc",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
] as const;

let overlayFontReady = false;

function ensureOverlayFont(): void {
  if (overlayFontReady) return;
  for (const fontPath of OVERLAY_FONT_PATHS) {
    if (!existsSync(fontPath)) continue;
    try {
      GlobalFonts.registerFromPath(fontPath, OVERLAY_FONT_FAMILY);
      overlayFontReady = true;
      return;
    } catch {
      // Ignore and try the next available system font.
    }
  }
  overlayFontReady = true;
}

function fontFamily(): string {
  ensureOverlayFont();
  return OVERLAY_FONT_FAMILY;
}

function safeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function clipText(value: string, maxChars: number): string {
  const chars = Array.from(safeText(value));
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function firstSnippet(value: string, maxChars: number): string {
  const normalized = safeText(value)
    .split(/[。！？!?；;，,、]/u)
    .map((part) => part.trim())
    .filter(Boolean)[0] ?? safeText(value);
  return clipText(normalized, maxChars);
}

function rgba(red: number, green: number, blue: number, alpha: number): string {
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

function fillRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string,
): void {
  ctx.save();
  roundRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

function strokeRoundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  strokeStyle: string,
  lineWidth: number,
): void {
  ctx.save();
  roundRect(ctx, x, y, width, height, radius);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.restore();
}

function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const chars = Array.from(safeText(text));
  if (chars.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const char of chars) {
    const next = `${current}${char}`;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = char;
      if (lines.length >= maxLines) break;
      continue;
    }
    current = next;
  }
  if (lines.length < maxLines && current) {
    lines.push(current);
  }
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines);
  }
  if (lines.length === maxLines && chars.join("") !== lines.join("")) {
    const lastChars = Array.from(lines[maxLines - 1] ?? "");
    lines[maxLines - 1] = `${lastChars.slice(0, Math.max(0, lastChars.length - 1)).join("")}…`;
  }
  return lines;
}

function fitWrappedText(args: {
  readonly ctx: SKRSContext2D;
  readonly text: string;
  readonly maxWidth: number;
  readonly maxLines: number;
  readonly startSize: number;
  readonly minSize: number;
  readonly weight?: string;
}): { fontSize: number; lines: string[] } {
  for (let size = args.startSize; size >= args.minSize; size -= 2) {
    args.ctx.font = `${args.weight ?? "600"} ${size}px "${fontFamily()}"`;
    const lines = wrapText(args.ctx, args.text, args.maxWidth, args.maxLines);
    if (lines.length <= args.maxLines && lines.every((line) => args.ctx.measureText(line).width <= args.maxWidth)) {
      return { fontSize: size, lines };
    }
  }
  args.ctx.font = `${args.weight ?? "600"} ${args.minSize}px "${fontFamily()}"`;
  return {
    fontSize: args.minSize,
    lines: wrapText(args.ctx, args.text, args.maxWidth, args.maxLines),
  };
}

function topMetaLine(brief: LocalBusinessPromoBrief): string {
  return [safeText(brief.cityArea), safeText(brief.industry)].filter(Boolean).join(" · ");
}

function highlightLine(args: {
  readonly brief: LocalBusinessPromoBrief;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly shotIndex: number;
  readonly totalShots: number;
}): string {
  if (args.shot.materialGroup === "process") return firstSnippet(args.brief.mainOffer || args.brief.sellingPoints, 20);
  if (args.shot.materialGroup === "result" || args.shotIndex === args.totalShots - 1) {
    return firstSnippet(args.brief.sellingPoints || args.brief.mainOffer, 22);
  }
  return firstSnippet(args.brief.mainOffer || args.brief.targetCustomers || args.brief.sellingPoints, 18);
}

function drawBrandCard(args: {
  readonly ctx: SKRSContext2D;
  readonly width: number;
  readonly height: number;
  readonly brief: LocalBusinessPromoBrief;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly shotIndex: number;
  readonly totalShots: number;
}): void {
  const { ctx, width, height, brief } = args;
  const paddingX = Math.round(width * 0.06);
  const top = Math.round(height * 0.05);
  const cardWidth = Math.min(Math.round(width * 0.62), 420);
  const cardHeight = Math.round(height * 0.115);
  fillRoundRect(ctx, paddingX, top, cardWidth, cardHeight, 24, rgba(10, 14, 25, 0.42));
  strokeRoundRect(ctx, paddingX, top, cardWidth, cardHeight, 24, rgba(255, 255, 255, 0.18), 2);

  const title = clipText(brief.storeName || "本地商家宣传", 18);
  const meta = clipText(topMetaLine(brief) || brief.mainOffer || brief.targetCustomers || "AI 智能混剪", 26);
  ctx.save();
  ctx.fillStyle = rgba(255, 255, 255, 0.98);
  ctx.textBaseline = "top";
  ctx.font = `700 ${Math.max(28, Math.round(height * 0.03))}px "${fontFamily()}"`;
  ctx.fillText(title, paddingX + 24, top + 18);

  ctx.fillStyle = rgba(228, 233, 243, 0.88);
  ctx.font = `500 ${Math.max(18, Math.round(height * 0.018))}px "${fontFamily()}"`;
  ctx.fillText(meta, paddingX + 24, top + 18 + Math.max(34, Math.round(height * 0.032)));
  ctx.restore();

  const chipText = highlightLine(args);
  if (!chipText) return;
  const chipPaddingX = 20;
  const chipPaddingY = 12;
  ctx.save();
  ctx.font = `600 ${Math.max(18, Math.round(height * 0.018))}px "${fontFamily()}"`;
  const chipWidth = Math.min(Math.round(ctx.measureText(chipText).width + chipPaddingX * 2), Math.round(width * 0.34));
  const chipHeight = Math.round(height * 0.05);
  const chipLeft = width - paddingX - chipWidth;
  const chipTop = top + Math.round(cardHeight * 0.18);
  fillRoundRect(ctx, chipLeft, chipTop, chipWidth, chipHeight, chipHeight / 2, rgba(247, 199, 79, 0.95));
  ctx.fillStyle = rgba(33, 28, 18, 0.96);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(chipText, chipLeft + (chipWidth / 2), chipTop + (chipHeight / 2) + 1);
  ctx.restore();
}

function drawSubtitle(args: {
  readonly ctx: SKRSContext2D;
  readonly width: number;
  readonly height: number;
  readonly subtitleText: string;
  readonly subtitlePlacement: LocalBusinessPromoSubtitlePlacement;
  readonly subtitleStyle: LocalBusinessPromoSubtitleStyle;
}): void {
  if (args.subtitleStyle === "none" || args.subtitlePlacement === "none") return;
  const maxWidth = Math.round(args.width * 0.82);
  const fitted = fitWrappedText({
    ctx: args.ctx,
    text: args.subtitleText,
    maxWidth,
    maxLines: 2,
    startSize: Math.max(34, Math.round(args.height * 0.036)),
    minSize: Math.max(26, Math.round(args.height * 0.026)),
    weight: args.subtitleStyle === "xiaohongshu-clean" ? "600" : "700",
  });
  if (fitted.lines.length === 0) return;

  const lineHeight = Math.round(fitted.fontSize * 1.3);
  const panelPaddingX = args.subtitleStyle === "xiaohongshu-clean" ? 20 : 24;
  const panelPaddingY = args.subtitleStyle === "xiaohongshu-clean" ? 12 : 14;
  args.ctx.save();
  args.ctx.font = `${args.subtitleStyle === "xiaohongshu-clean" ? "600" : "700"} ${fitted.fontSize}px "${fontFamily()}"`;
  const textWidth = fitted.lines.reduce((max, line) => Math.max(max, args.ctx.measureText(line).width), 0);
  args.ctx.restore();
  const panelHeight = (fitted.lines.length * lineHeight) + (panelPaddingY * 2);
  const panelWidth = Math.min(maxWidth + (panelPaddingX * 2), Math.round(textWidth + (panelPaddingX * 2)));
  const panelLeft = Math.round((args.width - panelWidth) / 2);
  const bottomTop = args.height - panelHeight - Math.round(args.height * 0.082);
  const topTop = Math.round(args.height * 0.19);
  const centerTop = Math.round((args.height * 0.62) - (panelHeight / 2));
  const panelTop = args.subtitlePlacement === "top"
    ? topTop
    : args.subtitlePlacement === "center"
      ? centerTop
      : bottomTop;
  const isClean = args.subtitleStyle === "xiaohongshu-clean";
  const isBottomClean = args.subtitleStyle === "bottom-clean";

  fillRoundRect(
    args.ctx,
    panelLeft,
    panelTop,
    panelWidth,
    panelHeight,
    22,
    isClean ? rgba(255, 255, 255, 0.84) : rgba(7, 10, 16, isBottomClean ? 0.42 : 0.56),
  );

  args.ctx.save();
  args.ctx.font = `${args.subtitleStyle === "xiaohongshu-clean" ? "600" : "700"} ${fitted.fontSize}px "${fontFamily()}"`;
  args.ctx.textAlign = "center";
  args.ctx.textBaseline = "top";
  for (let index = 0; index < fitted.lines.length; index += 1) {
    const line = fitted.lines[index]!;
    const y = panelTop + panelPaddingY + (index * lineHeight);
    if (args.subtitleStyle === "douyin-outline") {
      args.ctx.lineWidth = Math.max(3, Math.round(fitted.fontSize * 0.12));
      args.ctx.strokeStyle = rgba(17, 19, 27, 0.96);
      args.ctx.strokeText(line, args.width / 2, y);
      args.ctx.fillStyle = rgba(255, 255, 255, 0.98);
      args.ctx.fillText(line, args.width / 2, y);
      continue;
    }
    args.ctx.fillStyle = isClean ? rgba(26, 29, 38, 0.96) : rgba(255, 255, 255, 0.98);
    args.ctx.fillText(line, args.width / 2, y);
  }
  args.ctx.restore();
}

export function outputSize(aspectRatio: LocalBusinessPromoAspectRatio) {
  if (aspectRatio === "16:9") return { width: 1280, height: 720 };
  if (aspectRatio === "1:1") return { width: 720, height: 720 };
  return { width: 720, height: 1280 };
}

export async function renderLocalBusinessPromoOverlay(args: {
  readonly outputPath: string;
  readonly aspectRatio: LocalBusinessPromoAspectRatio;
  readonly brief: LocalBusinessPromoBrief;
  readonly shot: LocalBusinessPromoShotPlanEntry;
  readonly shotIndex: number;
  readonly totalShots: number;
  readonly subtitleStyle: LocalBusinessPromoSubtitleStyle;
}): Promise<boolean> {
  const storeName = safeText(args.brief.storeName);
  const subtitleText = safeText(args.shot.scriptLine);
  const highlight = safeText(highlightLine(args));
  if (!storeName && !subtitleText && !highlight) return false;

  const { width, height } = outputSize(args.aspectRatio);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  drawBrandCard({
    ctx,
    width,
    height,
    brief: args.brief,
    shot: args.shot,
    shotIndex: args.shotIndex,
    totalShots: args.totalShots,
  });
  if (subtitleText) {
    drawSubtitle({
      ctx,
      width,
      height,
      subtitleText,
      subtitlePlacement: args.shot.subtitlePlacement ?? "bottom",
      subtitleStyle: args.subtitleStyle,
    });
  }

  await writeFile(args.outputPath, canvas.toBuffer("image/png"));
  return true;
}
