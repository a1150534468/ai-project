-- CreateTable
CREATE TABLE "AgentTeam" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mainAgentPrompt" TEXT NOT NULL DEFAULT '',
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "responsibility" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "skills" JSONB NOT NULL DEFAULT '[]',
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT,
    "taskGoal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "teamSnapshot" JSONB NOT NULL DEFAULT '{}',
    "planSnapshot" JSONB NOT NULL DEFAULT '{}',
    "finalReport" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "operationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "AgentWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "memberName" TEXT NOT NULL,
    "memberSnapshot" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "position" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentWorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWorkflowEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "userId" TEXT NOT NULL,
    "memberName" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentWorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTeam_sourceRunId_idx" ON "AgentTeam"("sourceRunId");

-- CreateIndex
CREATE INDEX "AgentTeam_userId_updatedAt_idx" ON "AgentTeam"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTeam_id_userId_key" ON "AgentTeam"("id", "userId");

-- CreateIndex
CREATE INDEX "AgentTeamMember_teamId_position_idx" ON "AgentTeamMember"("teamId", "position");

-- CreateIndex
CREATE INDEX "AgentTeamMember_userId_updatedAt_idx" ON "AgentTeamMember"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowRun_userId_updatedAt_idx" ON "AgentWorkflowRun"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowRun_userId_status_updatedAt_idx" ON "AgentWorkflowRun"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowRun_status_updatedAt_idx" ON "AgentWorkflowRun"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowRun_teamId_updatedAt_idx" ON "AgentWorkflowRun"("teamId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflowRun_id_userId_key" ON "AgentWorkflowRun"("id", "userId");

-- CreateIndex
CREATE INDEX "AgentWorkflowStep_runId_position_idx" ON "AgentWorkflowStep"("runId", "position");

-- CreateIndex
CREATE INDEX "AgentWorkflowStep_userId_updatedAt_idx" ON "AgentWorkflowStep"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowStep_status_updatedAt_idx" ON "AgentWorkflowStep"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWorkflowStep_id_runId_key" ON "AgentWorkflowStep"("id", "runId");

-- CreateIndex
CREATE INDEX "AgentWorkflowEvent_runId_createdAt_idx" ON "AgentWorkflowEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowEvent_stepId_createdAt_idx" ON "AgentWorkflowEvent"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentWorkflowEvent_userId_createdAt_idx" ON "AgentWorkflowEvent"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentTeam" ADD CONSTRAINT "AgentTeam_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTeamMember" ADD CONSTRAINT "AgentTeamMember_teamId_userId_fkey" FOREIGN KEY ("teamId", "userId") REFERENCES "AgentTeam"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTeamMember" ADD CONSTRAINT "AgentTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowRun" ADD CONSTRAINT "AgentWorkflowRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowRun" ADD CONSTRAINT "AgentWorkflowRun_teamId_userId_fkey" FOREIGN KEY ("teamId", "userId") REFERENCES "AgentTeam"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowStep" ADD CONSTRAINT "AgentWorkflowStep_runId_userId_fkey" FOREIGN KEY ("runId", "userId") REFERENCES "AgentWorkflowRun"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowStep" ADD CONSTRAINT "AgentWorkflowStep_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowEvent" ADD CONSTRAINT "AgentWorkflowEvent_runId_userId_fkey" FOREIGN KEY ("runId", "userId") REFERENCES "AgentWorkflowRun"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowEvent" ADD CONSTRAINT "AgentWorkflowEvent_stepId_runId_fkey" FOREIGN KEY ("stepId", "runId") REFERENCES "AgentWorkflowStep"("id", "runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWorkflowEvent" ADD CONSTRAINT "AgentWorkflowEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
