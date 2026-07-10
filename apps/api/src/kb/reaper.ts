import type { PrismaClient } from '@prisma/client';
import type { IndexDeps } from './indexer.js';
import { indexOnce } from './indexer.js';

export interface ReaperOpts {
  intervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  runIndex?: (docId: string) => Promise<void>;
}

/**
 * Single reaper pass: find candidates and run indexOnce for each.
 * Exported for testing (no need to wait for interval).
 *
 * Candidates: status='pending' OR (status='indexing' AND lockedAt < now()-leaseMs)
 * AND attempts < maxAttempts.
 * Processed in createdAt ascending order, max batchSize items.
 *
 * Errors in individual runIndex calls are caught and logged, not propagated.
 *
 * @returns Number of documents processed
 */
export async function reapOnce(
  prisma: PrismaClient,
  opts: {
    leaseMs: number;
    maxAttempts: number;
    batchSize: number;
    runIndex: (docId: string) => Promise<void>;
  },
): Promise<number> {
  const now = new Date();
  const leaseThreshold = new Date(now.getTime() - opts.leaseMs);

  // Find candidates: pending OR (indexing + expired lease) + attempts < maxAttempts
  const candidates = await prisma.document.findMany({
    where: {
      OR: [
        { status: 'pending' },
        {
          status: 'indexing',
          lockedAt: { lt: leaseThreshold },
        },
      ],
      attempts: { lt: opts.maxAttempts },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.batchSize,
  });

  let processed = 0;
  for (const doc of candidates) {
    try {
      await opts.runIndex(doc.id);
      processed++;
    } catch (err) {
      // Log error but continue with next document
      const errorMsg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      console.error(`[reaper] Failed to index document ${doc.id}: ${errorMsg}`);
    }
  }

  return processed;
}

/**
 * Start KB reaper: periodically find and reindex stale/failed documents.
 * Errors are logged, not propagated. Does not block between cycles.
 *
 * @returns { stop: () => void } to stop the reaper
 */
export function startKbReaper(
  deps: IndexDeps,
  opts?: ReaperOpts,
): { stop: () => void } {
  const intervalMs = opts?.intervalMs ?? parseInt(process.env.KB_REAPER_INTERVAL_MS ?? '30000', 10);
  const leaseMs = opts?.leaseMs ?? parseInt(process.env.KB_INDEX_LEASE_MS ?? '300000', 10);
  const maxAttempts = opts?.maxAttempts ?? parseInt(process.env.KB_MAX_ATTEMPTS ?? '3', 10);
  const batchSize = opts?.batchSize ?? 20;
  const runIndex = opts?.runIndex ?? ((docId: string) => indexOnce(deps, docId));

  const timer = setInterval(async () => {
    try {
      await reapOnce(deps.prisma, { leaseMs, maxAttempts, batchSize, runIndex });
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      console.error(`[reaper] Cycle failed: ${errorMsg}`);
    }
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
