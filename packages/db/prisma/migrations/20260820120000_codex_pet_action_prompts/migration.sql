-- Per-action generation guidance. Existing projects keep the previous behavior.
ALTER TABLE "CodexPetProject" ADD COLUMN "actionPrompts" JSONB NOT NULL DEFAULT '{}';
