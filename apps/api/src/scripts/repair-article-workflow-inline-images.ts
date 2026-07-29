/**
 * 把历史行里内嵌的 base64 配图换成 API 代理地址。
 *
 * 背景：配了对象存储但端点是 localhost 且没配公网前缀时，`storeWorkflowImage` 返回
 * data URL，图文工作流又把它写进 `bodyHtml` 和 `imageManifestJson`，于是一张 2.6MB 的图
 * 被存三份。实测 4 张图的一行 `bodyHtml` 10.5MB、详情接口 31.6MB。
 *
 * 字节本来就已经上传到对象存储（ImageAsset.objectKey 非空），所以这次修复不重出图、
 * 不产生任何扣费——只是把地址从「内嵌字节」换成「按 assetId 取」。
 *
 * 用法（--dry-run 只报告不落库）：
 *   cd apps/api && pnpm exec tsx --env-file=../../.env src/scripts/repair-article-workflow-inline-images.ts --dry-run
 */
import { PrismaClient } from "@prisma/client";
import { applyArticleImageManifestToHtml } from "../workflow/article-workflow-image-manifest.js";
import { articleWorkflowStorableImageUrl } from "../workflow/article-workflow-image-url.js";
import { parseArticleWorkflowImageManifestJson } from "../workflow/article-workflow-serializer.js";

const dryRun = process.argv.includes("--dry-run");
const prisma = new PrismaClient();

function summarize(label: string, value: string): string {
  return `${label}=${value.length}`;
}

async function main() {
  const projects = await prisma.articleWorkflowProject.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, platform: true, title: true, bodyHtml: true, imageManifestJson: true },
  });

  let repaired = 0;
  let savedBytes = 0;

  for (const project of projects) {
    const manifest = parseArticleWorkflowImageManifestJson(project.imageManifestJson);
    if (manifest.length === 0) continue;

    const assetIds = manifest.map((image) => image.assetId).filter((id): id is string => Boolean(id));
    const assets = assetIds.length > 0
      ? await prisma.imageAsset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, objectKey: true },
      })
      : [];
    const objectKeyById = new Map(assets.map((asset) => [asset.id, asset.objectKey] as const));

    const nextManifest = manifest.map((image) => {
      const objectKey = image.assetId ? objectKeyById.get(image.assetId) ?? null : null;
      return {
        ...image,
        imageUrl: articleWorkflowStorableImageUrl({ url: image.imageUrl, assetId: image.assetId, objectKey }),
        thumbnailUrl: articleWorkflowStorableImageUrl({ url: image.thumbnailUrl, assetId: image.assetId, objectKey }),
      };
    });

    const manifestChanged = JSON.stringify(nextManifest) !== JSON.stringify(manifest);
    // 正文按修好的 manifest 重建配图 section：这是生成链路本来就在用的规范操作
    const nextBodyHtml = project.bodyHtml.trim()
      ? applyArticleImageManifestToHtml(project.bodyHtml, nextManifest)
      : project.bodyHtml;
    const bodyChanged = nextBodyHtml !== project.bodyHtml;
    if (!manifestChanged && !bodyChanged) continue;

    const before = project.bodyHtml.length + JSON.stringify(project.imageManifestJson ?? null).length;
    const after = nextBodyHtml.length + JSON.stringify(nextManifest).length;
    savedBytes += before - after;
    repaired += 1;

    console.log([
      dryRun ? "[dry-run]" : "[repair]",
      project.id,
      project.platform,
      JSON.stringify(project.title.slice(0, 24)),
      summarize("bodyBefore", project.bodyHtml),
      summarize("bodyAfter", nextBodyHtml),
      `payloadBefore=${before}`,
      `payloadAfter=${after}`,
    ].join(" "));

    if (dryRun) continue;
    await prisma.articleWorkflowProject.update({
      where: { id: project.id },
      data: {
        bodyHtml: bodyChanged ? nextBodyHtml : undefined,
        imageManifestJson: manifestChanged ? (nextManifest as never) : undefined,
      },
    });
  }

  console.log(`${dryRun ? "[dry-run] " : ""}rows=${projects.length} repaired=${repaired} saved=${savedBytes} bytes`);
}

await main();
await prisma.$disconnect();
