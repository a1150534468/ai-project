import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/require-user.js";
import {
  assertFinalSpritesheet,
  assertPackageArtifact,
  CODEX_PET_INSTALL_URL_TTL_SECONDS,
  CODEX_PET_PREVIEW_ARTIFACT_PURPOSE,
  CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
  contentDisposition,
  DELIVERABLE_RUN_STATUSES,
  deliveryRunQuerySchema,
  hasOwnedArtifactObjectKey,
  isSafeRasterImageMime,
  packageFilename,
  projectParamsSchema,
  publicArtifactParamsSchema,
  publicArtifactQuerySchema,
  publicBaseUrl,
  safeDiagnostic,
  signCodexPetArtifact,
  signingSecret,
  verifyCodexPetArtifactSignature,
} from "./codex-pet-route-helpers.js";
import type { CodexPetRouteContext } from "./codex-pet-route-context.js";
import type { CodexPetArtifactShape, ProjectShape, RunShape } from "./codex-pet-route-types.js";

export function registerCodexPetDeliveryRoutes(app: FastifyInstance, ctx: CodexPetRouteContext) {
  const { deps, prisma, now, loadArtifact, ownedProject } = ctx;

  async function readyProjectAssets(userId: string, projectId: string, requestedRunId?: string) {
    const project = await ownedProject(userId, projectId);
    const runId = requestedRunId ?? project?.latestRunId;
    if (!project || !runId) return null;
    const run = await prisma.codexPetRun.findFirst({
      where: { id: runId, projectId: project.id, userId },
    });
    if (!run
      || !DELIVERABLE_RUN_STATUSES.includes(run.status as (typeof DELIVERABLE_RUN_STATUSES)[number])
      || !run.spritesheetArtifactId
      || !run.packageArtifactId) return null;
    const [spritesheet, packageArtifact] = await Promise.all([
      prisma.codexPetArtifact.findFirst({
        where: { id: run.spritesheetArtifactId, runId: run.id, projectId: project.id, userId },
      }),
      prisma.codexPetArtifact.findFirst({
        where: { id: run.packageArtifactId, runId: run.id, projectId: project.id, userId },
      }),
    ]);
    if (!spritesheet || !packageArtifact) return null;
    if (!assertFinalSpritesheet(spritesheet as CodexPetArtifactShape)
      || !assertPackageArtifact(packageArtifact as CodexPetArtifactShape)) return null;
    return {
      project: project as ProjectShape,
      run: run as RunShape,
      spritesheet: spritesheet as CodexPetArtifactShape,
      packageArtifact: packageArtifact as CodexPetArtifactShape,
    };
  }

  app.post("/api/workflow/codex-pets/projects/:projectId/install-link", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const query = deliveryRunQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "运行参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    const ready = await readyProjectAssets(userId, project.id, query.data.runId);
    if (!ready) return reply.code(409).send({ error: "桌宠兼容包尚未生成，暂不能安装" });
    try {
      const secret = signingSecret(deps);
      const origin = publicBaseUrl(deps);
      const expiresAtSeconds = Math.floor(now().getTime() / 1_000) + CODEX_PET_INSTALL_URL_TTL_SECONDS;
      const signature = signCodexPetArtifact(ready.spritesheet.id, expiresAtSeconds, secret);
      const imageUrl = `${origin}/api/public/codex-pets/artifacts/${encodeURIComponent(ready.spritesheet.id)}?exp=${expiresAtSeconds}&sig=${encodeURIComponent(signature)}`;
      const installParams = new URLSearchParams({
        name: ready.project.name,
        imageUrl,
        description: ready.project.description,
        spriteVersionNumber: "2",
      });
      app.log.info({ runId: ready.run.id, status: "install_link_issued" }, "Codex pet install link issued");
      return {
        success: true,
        data: {
          installUrl: `codex://pets/install?${installParams.toString()}`,
          imageUrl,
          expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
        },
      };
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), status: "install_signing_failed" }, "Codex pet install signing is not configured");
      return reply.code(503).send({ error: "Codex 安装地址暂未配置" });
    }
  });

  app.get("/api/workflow/codex-pets/projects/:projectId/download", { preHandler: requireUser }, async (request, reply) => {
    const userId = request.userId;
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "项目参数不合法" });
    const query = deliveryRunQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "运行参数不合法" });
    const project = await ownedProject(userId, params.data.projectId);
    if (!project) return reply.code(404).send({ error: "桌宠项目不存在" });
    const ready = await readyProjectAssets(userId, project.id, query.data.runId);
    if (!ready) return reply.code(409).send({ error: "桌宠兼容包尚未生成，暂不能下载" });
    try {
      const bytes = await loadArtifact(ready.packageArtifact.objectKey);
      const filename = packageFilename(ready.project, ready.packageArtifact);
      app.log.info({ runId: ready.run.id, status: "package_downloaded" }, "Codex pet package downloaded");
      return reply
        .header("Content-Disposition", contentDisposition(filename))
        .header("Content-Length", String(bytes.byteLength))
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type("application/zip")
        .send(bytes);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: ready.run.id, status: "package_download_failed" }, "Codex pet package download failed");
      return reply.code(502).send({ error: "桌宠兼容包读取失败" });
    }
  });

  app.get("/api/public/codex-pets/artifacts/:artifactId", async (request, reply) => {
    const params = publicArtifactParamsSchema.safeParse(request.params);
    const query = publicArtifactQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "资源地址不合法" });
    let secret: string;
    try {
      secret = signingSecret(deps);
    } catch {
      return reply.code(503).send({ error: "资源签名服务暂不可用" });
    }
    if (!verifyCodexPetArtifactSignature({
      artifactId: params.data.artifactId,
      expiresAtSeconds: query.data.exp,
      signature: query.data.sig,
      secret,
      nowSeconds: Math.floor(now().getTime() / 1_000),
      purpose: query.data.purpose === "preview"
        ? CODEX_PET_PREVIEW_ARTIFACT_PURPOSE
        : CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
    })) {
      return reply.code(401).send({ error: "资源地址已失效" });
    }
    const artifact = await prisma.codexPetArtifact.findFirst({
      where: { id: params.data.artifactId },
    });
    const shape = artifact as CodexPetArtifactShape | null;
    if (query.data.purpose === "preview") {
      if (!shape
        || shape.status !== "ready"
        || !isSafeRasterImageMime(shape.mime)
        || !hasOwnedArtifactObjectKey(shape)
        || (shape.expiresAt !== null && shape.expiresAt.getTime() <= now().getTime())) {
        return reply.code(404).send({ error: "桌宠预览不存在" });
      }
    } else {
      if (!shape || !assertFinalSpritesheet(shape)) {
        return reply.code(404).send({ error: "桌宠精灵图不存在" });
      }
      const run = await prisma.codexPetRun.findFirst({
        where: {
          id: shape.runId,
          projectId: shape.projectId,
          userId: shape.userId,
          spritesheetArtifactId: shape.id,
        },
      });
      if (!run || !DELIVERABLE_RUN_STATUSES.includes(run.status as (typeof DELIVERABLE_RUN_STATUSES)[number])) {
        return reply.code(404).send({ error: "桌宠精灵图不存在" });
      }
    }
    if (!shape) return reply.code(404).send({ error: "桌宠资源不存在" });
    try {
      const bytes = await loadArtifact(shape.objectKey);
      const maxAge = Math.max(0, Math.min(300, query.data.exp - Math.floor(now().getTime() / 1_000)));
      app.log.info({ runId: shape.runId, status: query.data.purpose === "preview" ? "preview_served" : "install_image_served" }, "Codex pet signed artifact served");
      return reply
        .header("Content-Length", String(bytes.byteLength))
        .header("Cache-Control", `private, max-age=${maxAge}`)
        .header("Content-Disposition", "inline")
        .header("X-Content-Type-Options", "nosniff")
        .type(shape.mime)
        .send(bytes);
    } catch (error) {
      app.log.error({ error: safeDiagnostic(error), runId: shape.runId, status: "signed_artifact_read_failed" }, "Codex pet signed artifact read failed");
      return reply.code(502).send({ error: "桌宠资源读取失败" });
    }
  });
}
