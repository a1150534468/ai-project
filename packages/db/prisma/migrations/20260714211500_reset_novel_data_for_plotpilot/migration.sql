-- Final destructive cutover to the PlotPilot-equivalent novel domain model.
-- The user explicitly opted out of preserving or migrating any legacy novel data.
-- NovelProject is the aggregate root; CASCADE clears chapters, Bible, narrative
-- assets, tasks, runs, checkpoints, prompts, outbox commands and vector memories.
-- Account, billing, model, chat and knowledge-base tables are not affected.

TRUNCATE TABLE "NovelProject" CASCADE;

DROP TABLE IF EXISTS "NovelSectionVersion";
DROP TABLE IF EXISTS "NovelSection";
