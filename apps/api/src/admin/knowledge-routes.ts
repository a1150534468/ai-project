import type { FastifyInstance } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { getS3 } from "../storage/s3.js";
import { registerAdminKnowledgeBaseRoutes } from "./knowledge-base-routes.js";
import { registerAdminKnowledgeDocumentRoutes } from "./knowledge-document-routes.js";

export async function adminKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  const context = { prisma: getPrisma(), getS3 };
  registerAdminKnowledgeBaseRoutes(app, context);
  registerAdminKnowledgeDocumentRoutes(app, context);
}
