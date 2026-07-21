ALTER TABLE "CodexPetRun"
  ADD COLUMN "imageGenerationCallCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "imageGenerationApprovalBudget" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pendingImageJobKey" TEXT;

-- Best-effort historical backfill from durable provider correlation IDs.
-- New runs increment the counter before every outbound image request, so they
-- also count failures that did not return an upstream request ID.
UPDATE "CodexPetRun" AS run
SET "imageGenerationCallCount" = evidence.call_count
FROM (
  SELECT run_id, COUNT(DISTINCT request_id)::INTEGER AS call_count
  FROM (
    SELECT artifact."runId" AS run_id, artifact.metadata->>'upstreamRequestId' AS request_id
    FROM "CodexPetArtifact" AS artifact
    WHERE artifact.kind IN ('base_candidate', 'pose_board')
    UNION ALL
    SELECT event."runId" AS run_id, event.payload->>'upstreamRequestId' AS request_id
    FROM "CodexPetEvent" AS event
    WHERE event.payload ? 'upstreamRequestId'
  ) AS requests
  WHERE request_id IS NOT NULL AND request_id <> ''
  GROUP BY run_id
) AS evidence
WHERE run.id = evidence.run_id;
