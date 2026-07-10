import type { FastifyInstance } from "fastify";
import { createBillingClient } from "@yc/billing";
import { getPrisma } from "@yc/db";
import { ensureLocalBusinessPromoBgmLibrary } from "./audio-service.js";
import { registerLocalBusinessPromoAudioRoutes } from "./local-business-promo-audio-routes.js";
import { enqueueLocalBusinessPromoRun } from "./local-business-promo-queue.js";
import { registerLocalBusinessPromoProjectRoutes } from "./local-business-promo-project-routes.js";
import { registerLocalBusinessPromoRunRoutes } from "./local-business-promo-run-routes.js";
import { generateLocalBusinessPromoScript } from "./local-business-promo-script.js";
import type { LocalBusinessPromoRouteContext, LocalBusinessPromoRouteDeps } from "./local-business-promo-route-types.js";

export async function localBusinessPromoRoutes(app: FastifyInstance, deps: LocalBusinessPromoRouteDeps = {}) {
  const prisma = deps.prisma ?? getPrisma();
  const billing = deps.billing ?? createBillingClient({
    baseUrl: process.env.BILLING_BASE_URL!,
    token: process.env.BILLING_INTERNAL_TOKEN!,
  });
  const fetchFn = deps.fetchFn ?? fetch;
  const generateScript = deps.generateScript ?? ((input) => generateLocalBusinessPromoScript({ ...input, billing }));
  const enqueueRun = deps.enqueueRun ?? enqueueLocalBusinessPromoRun;
  const ctx: LocalBusinessPromoRouteContext = {
    prisma,
    billing,
    fetchFn,
    generateScript,
    enqueueRun,
  };

  await ensureLocalBusinessPromoBgmLibrary();
  registerLocalBusinessPromoProjectRoutes(app, ctx);
  registerLocalBusinessPromoAudioRoutes(app, ctx);
  registerLocalBusinessPromoRunRoutes(app, ctx);
}
