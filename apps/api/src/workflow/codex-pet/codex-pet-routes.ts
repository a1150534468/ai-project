import type { FastifyInstance } from "fastify";
import { createCodexPetRouteContext } from "./codex-pet-route-context.js";
import { registerCodexPetCatalogRoutes } from "./codex-pet-catalog-routes.js";
import { registerCodexPetProjectRoutes } from "./codex-pet-project-routes.js";
import { registerCodexPetRunRoutes } from "./codex-pet-run-routes.js";
import { registerCodexPetRunReviewRoutes } from "./codex-pet-run-review-routes.js";
import { registerCodexPetEventRoutes } from "./codex-pet-event-routes.js";
import { registerCodexPetDeliveryRoutes } from "./codex-pet-delivery-routes.js";
import type { CodexPetRouteDeps } from "./codex-pet-route-types.js";

export { codexPetValidationPassed } from "./codex-pet-delivery-validation.js";
export {
  CODEX_PET_EVENT_CHANNEL_PREFIX,
  CODEX_PET_INSTALL_URL_TTL_SECONDS,
  CODEX_PET_PREVIEW_ARTIFACT_PURPOSE,
  CODEX_PET_PREVIEW_URL_TTL_SECONDS,
  CODEX_PET_PUBLIC_ARTIFACT_PURPOSE,
  codexPetRunEventChannel,
  deriveCodexPetRunId,
  formatCodexPetSseEvent,
  signCodexPetArtifact,
  validateCodexPetReferenceAsset,
  verifyCodexPetArtifactSignature,
} from "./codex-pet-route-helpers.js";
export type { CodexPetArtifactShape, CodexPetRouteDeps } from "./codex-pet-route-types.js";

// 门面：对外契约（导出符号与路由注册顺序）与拆分前逐字一致。原来 2961 行的插件
// 体被按路由分组搬进同目录的兄弟文件，测试与外部 import 一行都没有改。
export async function codexPetRoutes(app: FastifyInstance, deps: CodexPetRouteDeps = {}) {
  const ctx = createCodexPetRouteContext(app, deps);

  registerCodexPetCatalogRoutes(app, ctx);
  registerCodexPetProjectRoutes(app, ctx);
  registerCodexPetRunRoutes(app, ctx);
  registerCodexPetRunReviewRoutes(app, ctx);
  registerCodexPetEventRoutes(app, ctx);
  registerCodexPetDeliveryRoutes(app, ctx);
}
