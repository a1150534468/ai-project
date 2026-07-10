import type { FastifyInstance } from "fastify";
import { registerLocalBusinessPromoAudioBlobRoutes } from "./local-business-promo-audio-blob-routes.js";
import { registerLocalBusinessPromoBgmRoutes } from "./local-business-promo-audio-bgm-routes.js";
import { registerLocalBusinessPromoNarrationRoutes } from "./local-business-promo-audio-narration-routes.js";
import { registerLocalBusinessPromoAudioStateRoutes } from "./local-business-promo-audio-state-routes.js";
import { registerLocalBusinessPromoAudioUploadRoutes } from "./local-business-promo-audio-upload-routes.js";
import type { LocalBusinessPromoRouteContext } from "./local-business-promo-route-types.js";

export function registerLocalBusinessPromoAudioRoutes(app: FastifyInstance, ctx: LocalBusinessPromoRouteContext) {
  registerLocalBusinessPromoAudioUploadRoutes(app, ctx);
  registerLocalBusinessPromoAudioBlobRoutes(app, ctx);
  registerLocalBusinessPromoNarrationRoutes(app, ctx);
  registerLocalBusinessPromoBgmRoutes(app, ctx);
  registerLocalBusinessPromoAudioStateRoutes(app, ctx);
}
