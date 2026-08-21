import type { PrismaClient } from "@ai-assistant/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUB_STAGE } from "./dub-constants.js";
import { resolveBgmObjectKey } from "./dub-bgm-service.js";
import { mixBgmFiles } from "./dub-ffmpeg.js";
import { assertTempDiskSpace } from "../runtime/temp-storage.js";

const PATCHABLE = ["title", "sourceVideoUrl", "analysis", "script", "attachedKbIds", "ttsMode",
  "audioUrl", "audioObjectKey", "audioDurationSec", "avatarId", "bgmPresetId", "bgmObjectKey", "bgmVolume", "stage"] as const;
export type ProjectPatch = Partial<Record<(typeof PATCHABLE)[number], unknown>>;

export async function createProject(prisma: PrismaClient, userId: string, title?: string) {
  return prisma.dubProject.create({ data: { userId, title: title?.slice(0, 60) || "未命名口播" } });
}

export async function listProjects(prisma: PrismaClient, userId: string) {
  return prisma.dubProject.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function getProject(prisma: PrismaClient, userId: string, id: string) {
  return prisma.dubProject.findFirst({ where: { id, userId } });
}

// 白名单字段 + userId 限定：防越权，也防客户端注入 userId/finalVideoUrl 等字段
export async function patchProject(prisma: PrismaClient, userId: string, id: string, patch: ProjectPatch): Promise<boolean> {
  const data: Record<string, unknown> = {};
  for (const key of PATCHABLE) if (key in patch && patch[key] !== undefined) data[key] = patch[key];
  if (Object.keys(data).length === 0) return false;
  const r = await prisma.dubProject.updateMany({ where: { id, userId }, data });
  return r.count > 0;
}

export async function deleteProject(prisma: PrismaClient, userId: string, id: string): Promise<boolean> {
  const r = await prisma.dubProject.deleteMany({ where: { id, userId } });
  return r.count > 0;
}

export function assertReadyForGenerate(p: { audioObjectKey: string | null; avatarId: string | null }): void {
  if (!p.audioObjectKey) throw new Error("请先完成配音");
  if (!p.avatarId) throw new Error("请先选择数字人形象");
}

export interface FinalizeProjectArgs {
  prisma: PrismaClient;
  projectId: string;
  videoUrl: string;
  videoObjectKey: string;
  resolveBgmKey?: typeof resolveBgmObjectKey;
  getObjectToFile: (key: string, filePath: string) => Promise<unknown>;
  storeVideoFile: (a: { userId: string; filePath: string }) => Promise<{ url: string; objectKey: string }>;
  mixFn?: typeof mixBgmFiles;
}

// 成片完成后的收尾：无 BGM 直接定稿；有 BGM 则本地混流。
// 混流失败不抛出（视频已生成并交付、费用已按真实 duration 结算），置 stage=failed 并保留无 BGM 原片供下载，可用 remix 重试。
export async function finalizeProjectVideo(args: FinalizeProjectArgs): Promise<void> {
  const project = await args.prisma.dubProject.findUnique({ where: { id: args.projectId } });
  if (!project) return;
  const resolveBgm = args.resolveBgmKey ?? resolveBgmObjectKey;
  const mix = args.mixFn ?? mixBgmFiles;

  const bgmKey = await resolveBgm(args.prisma, { bgmObjectKey: project.bgmObjectKey, bgmPresetId: project.bgmPresetId });
  if (!bgmKey) {
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.done, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, finalVideoUrl: args.videoUrl, finalObjectKey: args.videoObjectKey, error: null },
    });
    return;
  }

  const workdir = await mkdtemp(join(tmpdir(), "dub-finalize-"));
  const videoPath = join(workdir, "source.mp4");
  const bgmPath = join(workdir, "bgm.audio");
  const outputPath = join(workdir, "final.mp4");
  try {
    await assertTempDiskSpace(outputPath);
    await Promise.all([
      args.getObjectToFile(args.videoObjectKey, videoPath),
      args.getObjectToFile(bgmKey, bgmPath),
    ]);
    await mix({ videoPath, bgmPath, outPath: outputPath, bgmVolume: project.bgmVolume });
    const stored = await args.storeVideoFile({ userId: project.userId, filePath: outputPath });
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.done, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, finalVideoUrl: stored.url, finalObjectKey: stored.objectKey, error: null },
    });
  } catch (e) {
    await args.prisma.dubProject.update({
      where: { id: project.id },
      data: { stage: DUB_STAGE.failed, resultVideoUrl: args.videoUrl, resultObjectKey: args.videoObjectKey, error: `BGM 混流失败：${(e as Error).message}` },
    }).catch(() => undefined);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
