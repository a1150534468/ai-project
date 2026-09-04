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
 * shouldStop is polled before each document: the caller can cut a batch short
 * (e.g. the reaper was stopped mid-cycle) without waiting for all batchSize items.
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
    shouldStop?: () => boolean;
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
    if (opts.shouldStop?.()) break;

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
 * Start KB reaper: periodically process pending documents and expired leases.
 * Retryable index failures are returned to pending by indexOnce; permanent
 * failures remain failed and are intentionally excluded from this loop.
 * Errors are logged, not propagated. Does not block between cycles.
 *
 * Two things the bare setInterval got wrong:
 * - cycles could overlap. A cycle takes as long as batchSize embeddings take,
 *   which is easily more than intervalMs; two live cycles then race for the same
 *   documents and only the DB lease keeps them apart. A tick that finds the
 *   previous cycle still running is skipped instead.
 * - stop() only cancelled future ticks. The cycle already in flight kept indexing
 *   for the rest of its batch, i.e. past server shutdown and its prisma pool.
 *   It now bails out between documents.
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
  const runIndex = opts?.runIndex ?? ((docId: string) => indexOnce(deps, docId, { maxAttempts }));

  let stopped = false;
  let running = false;

  const timer = setInterval(async () => {
    if (stopped || running) return;

    running = true;
    try {
      await reapOnce(deps.prisma, {
        leaseMs,
        maxAttempts,
        batchSize,
        runIndex,
        shouldStop: () => stopped,
      });
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
      console.error(`[reaper] Cycle failed: ${errorMsg}`);
    } finally {
      running = false;
    }
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
