import type { FastifyInstance } from "fastify";
import { getPrisma } from "@ai-assistant/db";
import { makeS3, type S3 } from "../storage/s3.js";
import { registerAdminKnowledgeBaseRoutes } from "./knowledge-base-routes.js";
import { registerAdminKnowledgeDocumentRoutes } from "./knowledge-document-routes.js";

export async function adminKnowledgeRoutes(app: FastifyInstance): Promise<void> {
  let s3: S3 | undefined;
  const context = {
    prisma: getPrisma(),
    getS3: () => {
      s3 ??= makeS3();
      return s3;
    },
  };
  registerAdminKnowledgeBaseRoutes(app, context);
  registerAdminKnowledgeDocumentRoutes(app, context);
}
