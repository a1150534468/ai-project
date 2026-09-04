-- 解耦 Phase 5：删掉 40 张随模块下线的表（方案 39 张 + 已确认下线的 KbQuotaGrant）。
--
-- ⚠️ 不可逆。执行前的全量备份：~/backups/aiproject-decouple-2026-09-04/main-before-drop.dump
--    （custom 格式 326 MB / 98 张表的数据，已用 pg_restore --list 验证可读）。
--
-- 这份 SQL 由 `prisma migrate diff --from-schema-datasource --to-schema-datamodel` 生成后
-- **手工删掉了三条 DROP INDEX**：
--   Chunk_embedding_hnsw_idx / Memory_embedding_hnsw_idx / NovelVectorMemory_embedding_hnsw_idx
-- 它们是 20260713130000_bailian_embedding_v4_1024 用裸 SQL 建的 pgvector HNSW 索引，
-- 而 schema 里 embedding 列是 Unsupported("vector(1024)")、datamodel 认不出这些索引，
-- 于是 diff 把它们当成漂移要删。删掉等于把知识库与记忆的向量检索退化成全表扫 ——
-- 那是两个要保留的模块。**以后再跑 migrate diff 生成迁移时，同样要把这三条摘掉。**
--
-- User.channelId 列与它的索引跟着 Channel 表一起走（分销下线）。
-- AudioAsset.projectId 保留为普通列（素材库还靠它做折叠分组），只删外键约束。

-- DropForeignKey
ALTER TABLE "AgentTeam" DROP CONSTRAINT "AgentTeam_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentTeamMember" DROP CONSTRAINT "AgentTeamMember_teamId_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentTeamMember" DROP CONSTRAINT "AgentTeamMember_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowEvent" DROP CONSTRAINT "AgentWorkflowEvent_runId_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowEvent" DROP CONSTRAINT "AgentWorkflowEvent_stepId_runId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowEvent" DROP CONSTRAINT "AgentWorkflowEvent_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowRun" DROP CONSTRAINT "AgentWorkflowRun_teamId_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowRun" DROP CONSTRAINT "AgentWorkflowRun_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowStep" DROP CONSTRAINT "AgentWorkflowStep_runId_userId_fkey";

-- DropForeignKey
ALTER TABLE "AgentWorkflowStep" DROP CONSTRAINT "AgentWorkflowStep_userId_fkey";

-- DropForeignKey
ALTER TABLE "AudioAsset" DROP CONSTRAINT "AudioAsset_projectId_fkey";

-- DropForeignKey
ALTER TABLE "AudioGenerationTask" DROP CONSTRAINT "AudioGenerationTask_assetId_fkey";

-- DropForeignKey
ALTER TABLE "AudioGenerationTask" DROP CONSTRAINT "AudioGenerationTask_projectId_fkey";

-- DropForeignKey
ALTER TABLE "AudioGenerationTask" DROP CONSTRAINT "AudioGenerationTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowAsset" DROP CONSTRAINT "ComicWorkflowAsset_imageAssetId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowAsset" DROP CONSTRAINT "ComicWorkflowAsset_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowAsset" DROP CONSTRAINT "ComicWorkflowAsset_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowBibleEntry" DROP CONSTRAINT "ComicWorkflowBibleEntry_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowBibleEntry" DROP CONSTRAINT "ComicWorkflowBibleEntry_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowEpisode" DROP CONSTRAINT "ComicWorkflowEpisode_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowEpisode" DROP CONSTRAINT "ComicWorkflowEpisode_scriptVersionId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowEpisode" DROP CONSTRAINT "ComicWorkflowEpisode_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowProject" DROP CONSTRAINT "ComicWorkflowProject_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" DROP CONSTRAINT "ComicWorkflowScriptVersion_episodeId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" DROP CONSTRAINT "ComicWorkflowScriptVersion_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowScriptVersion" DROP CONSTRAINT "ComicWorkflowScriptVersion_userId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowShot" DROP CONSTRAINT "ComicWorkflowShot_episodeId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowShot" DROP CONSTRAINT "ComicWorkflowShot_imageAssetId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowShot" DROP CONSTRAINT "ComicWorkflowShot_projectId_fkey";

-- DropForeignKey
ALTER TABLE "ComicWorkflowShot" DROP CONSTRAINT "ComicWorkflowShot_userId_fkey";

-- DropForeignKey
ALTER TABLE "DubProject" DROP CONSTRAINT "DubProject_userId_fkey";

-- DropForeignKey
ALTER TABLE "EcomMainImageJob" DROP CONSTRAINT "EcomMainImageJob_userId_fkey";

-- DropForeignKey
ALTER TABLE "EcomWorkflow" DROP CONSTRAINT "EcomWorkflow_userId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoProject" DROP CONSTRAINT "LocalBusinessPromoProject_activeBgmAssetId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoProject" DROP CONSTRAINT "LocalBusinessPromoProject_activeNarrationAssetId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoProject" DROP CONSTRAINT "LocalBusinessPromoProject_userId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoProject" DROP CONSTRAINT "LocalBusinessPromoProject_voiceCloneSampleAssetId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoRun" DROP CONSTRAINT "LocalBusinessPromoRun_projectId_fkey";

-- DropForeignKey
ALTER TABLE "LocalBusinessPromoRun" DROP CONSTRAINT "LocalBusinessPromoRun_userId_fkey";

-- DropForeignKey
ALTER TABLE "LoginEvent" DROP CONSTRAINT "LoginEvent_userId_fkey";

-- DropForeignKey
ALTER TABLE "PortraitOutput" DROP CONSTRAINT "PortraitOutput_taskId_fkey";

-- DropForeignKey
ALTER TABLE "PortraitOutput" DROP CONSTRAINT "PortraitOutput_userId_fkey";

-- DropForeignKey
ALTER TABLE "PortraitReferenceAsset" DROP CONSTRAINT "PortraitReferenceAsset_userId_fkey";

-- DropForeignKey
ALTER TABLE "PortraitTask" DROP CONSTRAINT "PortraitTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledTask" DROP CONSTRAINT "ScheduledTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledTaskRun" DROP CONSTRAINT "ScheduledTaskRun_taskId_fkey";

-- DropForeignKey
ALTER TABLE "ScheduledTaskRun" DROP CONSTRAINT "ScheduledTaskRun_userId_fkey";

-- DropForeignKey
ALTER TABLE "SkyhumanTask" DROP CONSTRAINT "SkyhumanTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "TryOnOutput" DROP CONSTRAINT "TryOnOutput_taskId_fkey";

-- DropForeignKey
ALTER TABLE "TryOnOutput" DROP CONSTRAINT "TryOnOutput_userId_fkey";

-- DropForeignKey
ALTER TABLE "TryOnReferenceAsset" DROP CONSTRAINT "TryOnReferenceAsset_userId_fkey";

-- DropForeignKey
ALTER TABLE "TryOnTask" DROP CONSTRAINT "TryOnTask_userId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_channelId_fkey";

-- DropForeignKey
ALTER TABLE "UserToolInstall" DROP CONSTRAINT "UserToolInstall_userId_fkey";

-- DropForeignKey
ALTER TABLE "VideoGenerationTask" DROP CONSTRAINT "VideoGenerationTask_userId_fkey";

-- DropIndex
DROP INDEX "User_channelId_idx";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "channelId";

-- DropTable
DROP TABLE "AgentTeam";

-- DropTable
DROP TABLE "AgentTeamMember";

-- DropTable
DROP TABLE "AgentWorkflowEvent";

-- DropTable
DROP TABLE "AgentWorkflowRun";

-- DropTable
DROP TABLE "AgentWorkflowStep";

-- DropTable
DROP TABLE "AudioGenerationTask";

-- DropTable
DROP TABLE "Channel";

-- DropTable
DROP TABLE "CohortDaily";

-- DropTable
DROP TABLE "ComicWorkflowAsset";

-- DropTable
DROP TABLE "ComicWorkflowBibleEntry";

-- DropTable
DROP TABLE "ComicWorkflowEpisode";

-- DropTable
DROP TABLE "ComicWorkflowProject";

-- DropTable
DROP TABLE "ComicWorkflowScriptVersion";

-- DropTable
DROP TABLE "ComicWorkflowShot";

-- DropTable
DROP TABLE "Device";

-- DropTable
DROP TABLE "DeviceSession";

-- DropTable
DROP TABLE "DubBgmPreset";

-- DropTable
DROP TABLE "DubProject";

-- DropTable
DROP TABLE "EcomMainImageJob";

-- DropTable
DROP TABLE "EcomWorkflow";

-- DropTable
DROP TABLE "KbQuotaGrant";

-- DropTable
DROP TABLE "LocalBusinessPromoProject";

-- DropTable
DROP TABLE "LocalBusinessPromoRun";

-- DropTable
DROP TABLE "LoginEvent";

-- DropTable
DROP TABLE "MetricsDaily";

-- DropTable
DROP TABLE "PortraitOutput";

-- DropTable
DROP TABLE "PortraitReferenceAsset";

-- DropTable
DROP TABLE "PortraitTask";

-- DropTable
DROP TABLE "ReportTask";

-- DropTable
DROP TABLE "ResellerVisibilityConfig";

-- DropTable
DROP TABLE "ScheduledTask";

-- DropTable
DROP TABLE "ScheduledTaskRun";

-- DropTable
DROP TABLE "SkyhumanTask";

-- DropTable
DROP TABLE "TryOnOutput";

-- DropTable
DROP TABLE "TryOnReferenceAsset";

-- DropTable
DROP TABLE "TryOnTask";

-- DropTable
DROP TABLE "UserToolInstall";

-- DropTable
DROP TABLE "VideoGenerationTask";

-- DropTable
DROP TABLE "VideoMaterial";

-- DropTable
DROP TABLE "WechatBinding";

