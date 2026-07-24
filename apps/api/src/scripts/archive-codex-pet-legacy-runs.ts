import "../env.js";
import { getPrisma } from "@ai-assistant/db";
import { archiveCodexPetLegacyRuns } from "../workflow/codex-pet-read-only-archive.js";

const runIds = (process.env.CODEX_PET_ARCHIVE_RUN_IDS ?? "")
  .split(",")
  .map((runId) => runId.trim())
  .filter(Boolean);

if (process.argv[2] !== "--apply") {
  throw new Error("pass --apply after setting CODEX_PET_ARCHIVE_RUN_IDS to archive legacy runs");
}

const prisma = getPrisma();
try {
  const archived = await archiveCodexPetLegacyRuns({ prisma, runIds });
  console.info(JSON.stringify({ archivedCount: archived.length, archived }));
} finally {
  await prisma.$disconnect();
}
