-- PlotPilot-equivalent novel engine substrate.
-- Legacy novel workflow data is intentionally discarded; no compatibility migration is provided.
-- pgvector HNSW indexes are deliberately left untouched.

TRUNCATE TABLE "NovelProject" CASCADE;

DROP TABLE IF EXISTS "NovelSectionVersion";
DROP TABLE IF EXISTS "NovelSection";

ALTER TABLE "NovelProject"
  ADD COLUMN "premise" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "generationPrefs" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "narrativeContract" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "targetChapters" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "targetCharsPerChapter" INTEGER NOT NULL DEFAULT 3000,
  ADD COLUMN "setupStage" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storyPhase" TEXT NOT NULL DEFAULT 'opening',
  ADD COLUMN "autopilotStatus" TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "currentBranch" TEXT NOT NULL DEFAULT 'main';

CREATE TABLE "NovelBible" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "premiseLock" TEXT NOT NULL DEFAULT '',
  "genreLock" TEXT NOT NULL DEFAULT '',
  "worldPresetLock" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelBible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelWorldDimension" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "bibleId" TEXT NOT NULL,
  "dimensionKey" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL DEFAULT '',
  "details" JSONB NOT NULL DEFAULT '{}',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelWorldDimension_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelStyleNote" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "bibleId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelStyleNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NovelBible_projectId_key" ON "NovelBible"("projectId");
CREATE UNIQUE INDEX "NovelWorldDimension_projectId_dimensionKey_key" ON "NovelWorldDimension"("projectId", "dimensionKey");
CREATE INDEX "NovelWorldDimension_bibleId_position_idx" ON "NovelWorldDimension"("bibleId", "position");
CREATE UNIQUE INDEX "NovelStyleNote_projectId_category_title_key" ON "NovelStyleNote"("projectId", "category", "title");
CREATE INDEX "NovelStyleNote_bibleId_position_idx" ON "NovelStyleNote"("bibleId", "position");

ALTER TABLE "NovelBible" ADD CONSTRAINT "NovelBible_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelWorldDimension" ADD CONSTRAINT "NovelWorldDimension_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelWorldDimension" ADD CONSTRAINT "NovelWorldDimension_bibleId_fkey" FOREIGN KEY ("bibleId") REFERENCES "NovelBible"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStyleNote" ADD CONSTRAINT "NovelStyleNote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStyleNote" ADD CONSTRAINT "NovelStyleNote_bibleId_fkey" FOREIGN KEY ("bibleId") REFERENCES "NovelBible"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NovelChapter"
  ADD COLUMN "outline" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "generationHint" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "executionPlan" JSONB,
  ADD COLUMN "microBeats" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "tensionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "plotTension" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "emotionalTension" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "pacingTension" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "NovelRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "currentStep" TEXT,
  "currentChapter" INTEGER,
  "startChapter" INTEGER NOT NULL DEFAULT 1,
  "targetChapters" INTEGER NOT NULL,
  "targetCharsPerChapter" INTEGER NOT NULL DEFAULT 3000,
  "completedChapters" INTEGER NOT NULL DEFAULT 0,
  "autoReview" BOOLEAN NOT NULL DEFAULT true,
  "pauseRequested" BOOLEAN NOT NULL DEFAULT false,
  "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastEventSequence" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelRunStep" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "chapterNumber" INTEGER,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "priority" INTEGER NOT NULL DEFAULT 5,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "input" JSONB NOT NULL DEFAULT '{}',
  "output" JSONB,
  "error" TEXT,
  "workerId" TEXT,
  "billingOperationId" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelRunStep_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelRunEvent" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "stage" TEXT NOT NULL,
  "step" TEXT,
  "chapterNumber" INTEGER,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelRunEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelCommandOutbox" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "stepId" TEXT,
  "taskId" TEXT,
  "queueName" TEXT NOT NULL DEFAULT 'novel-runs',
  "jobName" TEXT NOT NULL DEFAULT 'execute-step',
  "payload" JSONB NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 5,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelCommandOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelStructureNode" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "parentId" TEXT,
  "nodeType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "number" INTEGER NOT NULL,
  "startChapter" INTEGER,
  "endChapter" INTEGER,
  "outline" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelStructureNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelCharacter" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT '',
  "gender" TEXT NOT NULL DEFAULT '',
  "age" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "appearance" TEXT NOT NULL DEFAULT '',
  "personality" TEXT NOT NULL DEFAULT '',
  "publicProfile" TEXT NOT NULL DEFAULT '',
  "coreBelief" TEXT NOT NULL DEFAULT '',
  "coreMotivation" TEXT NOT NULL DEFAULT '',
  "innerLack" TEXT NOT NULL DEFAULT '',
  "moralTaboos" JSONB NOT NULL DEFAULT '[]',
  "voiceStyle" TEXT NOT NULL DEFAULT '',
  "state" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelCharacter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelCharacterRelation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fromCharacterId" TEXT NOT NULL,
  "toCharacterId" TEXT NOT NULL,
  "relationType" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "strength" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  "state" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelCharacterRelation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelLocation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "rules" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelTimelineEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterNumber" INTEGER,
  "timeLabel" TEXT NOT NULL DEFAULT '',
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "participants" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelStoryline" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "storylineType" TEXT NOT NULL DEFAULT 'main',
  "status" TEXT NOT NULL DEFAULT 'active',
  "goal" TEXT NOT NULL DEFAULT '',
  "conflict" TEXT NOT NULL DEFAULT '',
  "promiseTags" JSONB NOT NULL DEFAULT '[]',
  "aliases" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelStoryline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelStorylineMilestone" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "storylineId" TEXT NOT NULL,
  "chapterNumber" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'planned',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelStorylineMilestone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelProp" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "owner" TEXT NOT NULL DEFAULT '',
  "location" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelProp_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelPropEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "propId" TEXT NOT NULL,
  "chapterNumber" INTEGER,
  "eventType" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "stateAfter" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelPropEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelNarrativeEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterNumber" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "actors" JSONB NOT NULL DEFAULT '[]',
  "locations" JSONB NOT NULL DEFAULT '[]',
  "tags" JSONB NOT NULL DEFAULT '[]',
  "tension" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelNarrativeEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelCausalEdge" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "fromEventId" TEXT NOT NULL,
  "toEventId" TEXT NOT NULL,
  "relationType" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "evidence" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelCausalEdge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelNarrativeDebt" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "debtType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "introducedChapter" INTEGER,
  "dueChapter" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'open',
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelNarrativeDebt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelEntityState" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "chapterNumber" INTEGER NOT NULL,
  "state" JSONB NOT NULL,
  "sourceExcerpt" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelEntityState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelQualityReport" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "chapterId" TEXT,
  "chapterNumber" INTEGER,
  "runId" TEXT,
  "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "consistencyScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "styleScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "tensionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "issues" JSONB NOT NULL DEFAULT '[]',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "gatePassed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelQualityReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelCheckpoint" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "branchName" TEXT NOT NULL DEFAULT 'main',
  "parentId" TEXT,
  "chapterNumber" INTEGER,
  "label" TEXT NOT NULL DEFAULT '',
  "snapshot" JSONB NOT NULL,
  "isHead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelPromptTemplate" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "nodeKey" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "variables" JSONB NOT NULL DEFAULT '[]',
  "model" TEXT NOT NULL DEFAULT '',
  "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "activeVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NovelPromptTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NovelPromptVersion" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "variables" JSONB NOT NULL DEFAULT '[]',
  "model" TEXT NOT NULL DEFAULT '',
  "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  "changeNote" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NovelPromptVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NovelRun_projectId_updatedAt_idx" ON "NovelRun"("projectId", "updatedAt");
CREATE INDEX "NovelRun_userId_updatedAt_idx" ON "NovelRun"("userId", "updatedAt");
CREATE INDEX "NovelRun_status_updatedAt_idx" ON "NovelRun"("status", "updatedAt");
CREATE UNIQUE INDEX "NovelRun_one_active_project_idx" ON "NovelRun"("projectId")
  WHERE "status" IN ('queued', 'planning', 'writing', 'validating', 'postprocessing', 'awaitingReview', 'paused', 'failed');
CREATE UNIQUE INDEX "NovelRunStep_runId_sequence_key" ON "NovelRunStep"("runId", "sequence");
CREATE INDEX "NovelRunStep_runId_status_idx" ON "NovelRunStep"("runId", "status");
CREATE INDEX "NovelRunStep_status_updatedAt_idx" ON "NovelRunStep"("status", "updatedAt");
CREATE UNIQUE INDEX "NovelRunEvent_runId_sequence_key" ON "NovelRunEvent"("runId", "sequence");
CREATE INDEX "NovelRunEvent_projectId_createdAt_idx" ON "NovelRunEvent"("projectId", "createdAt");
CREATE INDEX "NovelRunEvent_runId_createdAt_idx" ON "NovelRunEvent"("runId", "createdAt");
CREATE UNIQUE INDEX "NovelCommandOutbox_stepId_key" ON "NovelCommandOutbox"("stepId");
CREATE UNIQUE INDEX "NovelCommandOutbox_taskId_key" ON "NovelCommandOutbox"("taskId");
CREATE INDEX "NovelCommandOutbox_status_availableAt_idx" ON "NovelCommandOutbox"("status", "availableAt");
CREATE INDEX "NovelCommandOutbox_runId_createdAt_idx" ON "NovelCommandOutbox"("runId", "createdAt");
CREATE INDEX "NovelStructureNode_projectId_parentId_number_idx" ON "NovelStructureNode"("projectId", "parentId", "number");
CREATE UNIQUE INDEX "NovelStructureNode_projectId_nodeType_number_parentId_key" ON "NovelStructureNode"("projectId", "nodeType", "number", "parentId");
CREATE UNIQUE INDEX "NovelCharacter_projectId_name_key" ON "NovelCharacter"("projectId", "name");
CREATE INDEX "NovelCharacter_projectId_role_idx" ON "NovelCharacter"("projectId", "role");
CREATE UNIQUE INDEX "NovelCharacterRelation_projectId_fromCharacterId_toCharacte_key" ON "NovelCharacterRelation"("projectId", "fromCharacterId", "toCharacterId", "relationType");
CREATE INDEX "NovelCharacterRelation_projectId_relationType_idx" ON "NovelCharacterRelation"("projectId", "relationType");
CREATE UNIQUE INDEX "NovelLocation_projectId_name_key" ON "NovelLocation"("projectId", "name");
CREATE INDEX "NovelTimelineEvent_projectId_chapterNumber_idx" ON "NovelTimelineEvent"("projectId", "chapterNumber");
CREATE UNIQUE INDEX "NovelStoryline_projectId_title_key" ON "NovelStoryline"("projectId", "title");
CREATE INDEX "NovelStoryline_projectId_status_idx" ON "NovelStoryline"("projectId", "status");
CREATE UNIQUE INDEX "NovelStorylineMilestone_storylineId_chapterNumber_title_key" ON "NovelStorylineMilestone"("storylineId", "chapterNumber", "title");
CREATE INDEX "NovelStorylineMilestone_projectId_chapterNumber_idx" ON "NovelStorylineMilestone"("projectId", "chapterNumber");
CREATE UNIQUE INDEX "NovelProp_projectId_name_key" ON "NovelProp"("projectId", "name");
CREATE INDEX "NovelPropEvent_projectId_chapterNumber_idx" ON "NovelPropEvent"("projectId", "chapterNumber");
CREATE INDEX "NovelPropEvent_propId_createdAt_idx" ON "NovelPropEvent"("propId", "createdAt");
CREATE INDEX "NovelNarrativeEvent_projectId_chapterNumber_idx" ON "NovelNarrativeEvent"("projectId", "chapterNumber");
CREATE UNIQUE INDEX "NovelCausalEdge_projectId_fromEventId_toEventId_relationTyp_key" ON "NovelCausalEdge"("projectId", "fromEventId", "toEventId", "relationType");
CREATE INDEX "NovelNarrativeDebt_projectId_status_dueChapter_idx" ON "NovelNarrativeDebt"("projectId", "status", "dueChapter");
CREATE UNIQUE INDEX "NovelEntityState_projectId_entityType_entityKey_chapterNumb_key" ON "NovelEntityState"("projectId", "entityType", "entityKey", "chapterNumber");
CREATE INDEX "NovelEntityState_projectId_chapterNumber_idx" ON "NovelEntityState"("projectId", "chapterNumber");
CREATE INDEX "NovelQualityReport_projectId_chapterNumber_idx" ON "NovelQualityReport"("projectId", "chapterNumber");
CREATE INDEX "NovelQualityReport_chapterId_createdAt_idx" ON "NovelQualityReport"("chapterId", "createdAt");
CREATE INDEX "NovelCheckpoint_projectId_branchName_createdAt_idx" ON "NovelCheckpoint"("projectId", "branchName", "createdAt");
CREATE INDEX "NovelCheckpoint_projectId_isHead_idx" ON "NovelCheckpoint"("projectId", "isHead");
CREATE UNIQUE INDEX "NovelCheckpoint_one_head_per_branch_idx" ON "NovelCheckpoint"("projectId", "branchName") WHERE "isHead" = true;
CREATE UNIQUE INDEX "NovelPromptTemplate_projectId_nodeKey_key" ON "NovelPromptTemplate"("projectId", "nodeKey");
CREATE INDEX "NovelPromptTemplate_projectId_category_idx" ON "NovelPromptTemplate"("projectId", "category");
CREATE UNIQUE INDEX "NovelPromptVersion_templateId_version_key" ON "NovelPromptVersion"("templateId", "version");
CREATE INDEX "NovelPromptVersion_templateId_createdAt_idx" ON "NovelPromptVersion"("templateId", "createdAt");

ALTER TABLE "NovelRun" ADD CONSTRAINT "NovelRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelRun" ADD CONSTRAINT "NovelRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelRunStep" ADD CONSTRAINT "NovelRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "NovelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelRunEvent" ADD CONSTRAINT "NovelRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "NovelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelRunEvent" ADD CONSTRAINT "NovelRunEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCommandOutbox" ADD CONSTRAINT "NovelCommandOutbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCommandOutbox" ADD CONSTRAINT "NovelCommandOutbox_runId_fkey" FOREIGN KEY ("runId") REFERENCES "NovelRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCommandOutbox" ADD CONSTRAINT "NovelCommandOutbox_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "NovelRunStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCommandOutbox" ADD CONSTRAINT "NovelCommandOutbox_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "NovelTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStructureNode" ADD CONSTRAINT "NovelStructureNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStructureNode" ADD CONSTRAINT "NovelStructureNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NovelStructureNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCharacter" ADD CONSTRAINT "NovelCharacter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCharacterRelation" ADD CONSTRAINT "NovelCharacterRelation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCharacterRelation" ADD CONSTRAINT "NovelCharacterRelation_fromCharacterId_fkey" FOREIGN KEY ("fromCharacterId") REFERENCES "NovelCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCharacterRelation" ADD CONSTRAINT "NovelCharacterRelation_toCharacterId_fkey" FOREIGN KEY ("toCharacterId") REFERENCES "NovelCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelLocation" ADD CONSTRAINT "NovelLocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelTimelineEvent" ADD CONSTRAINT "NovelTimelineEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStoryline" ADD CONSTRAINT "NovelStoryline_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStorylineMilestone" ADD CONSTRAINT "NovelStorylineMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelStorylineMilestone" ADD CONSTRAINT "NovelStorylineMilestone_storylineId_fkey" FOREIGN KEY ("storylineId") REFERENCES "NovelStoryline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelProp" ADD CONSTRAINT "NovelProp_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelPropEvent" ADD CONSTRAINT "NovelPropEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelPropEvent" ADD CONSTRAINT "NovelPropEvent_propId_fkey" FOREIGN KEY ("propId") REFERENCES "NovelProp"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelNarrativeEvent" ADD CONSTRAINT "NovelNarrativeEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCausalEdge" ADD CONSTRAINT "NovelCausalEdge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCausalEdge" ADD CONSTRAINT "NovelCausalEdge_fromEventId_fkey" FOREIGN KEY ("fromEventId") REFERENCES "NovelNarrativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCausalEdge" ADD CONSTRAINT "NovelCausalEdge_toEventId_fkey" FOREIGN KEY ("toEventId") REFERENCES "NovelNarrativeEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelNarrativeDebt" ADD CONSTRAINT "NovelNarrativeDebt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelEntityState" ADD CONSTRAINT "NovelEntityState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelQualityReport" ADD CONSTRAINT "NovelQualityReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelQualityReport" ADD CONSTRAINT "NovelQualityReport_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "NovelChapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NovelCheckpoint" ADD CONSTRAINT "NovelCheckpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelCheckpoint" ADD CONSTRAINT "NovelCheckpoint_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NovelCheckpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NovelPromptTemplate" ADD CONSTRAINT "NovelPromptTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "NovelProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NovelPromptVersion" ADD CONSTRAINT "NovelPromptVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "NovelPromptTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
