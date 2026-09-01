import type { Buffer } from "node:buffer";
import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

export type ResourcePrice = {
  readonly resourceKey: string;
  readonly displayName: string;
  readonly pricingType: "PER_CALL" | "PER_UNIT" | "VIDEO_IO";
  readonly rate: number;
  readonly perUnits: number;
  readonly enabled: boolean;
};

export interface CodexPetBilling {
  readonly chargeResource: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly charged: number }>;
  readonly reserveResource?: (args: {
    readonly operationId: string;
    readonly userId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly reserved: number }>;
  readonly settleResource?: (args: {
    readonly operationId: string;
    readonly resourceKey: string;
    readonly units: number;
  }) => Promise<{ readonly settled: number }>;
  readonly refundResource: (operationId: string) => Promise<{ readonly success: boolean }>;
  readonly listResourcePrices?: () => Promise<{ readonly data: readonly ResourcePrice[] }>;
  readonly listEnabledModels?: () => Promise<{
    readonly data: readonly {
      readonly model: string;
      readonly displayName: string;
      readonly maxOutputTokens?: number;
      readonly tags?: string;
    }[];
  }>;
}

export interface CodexPetArtifactShape {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly userId: string;
  readonly jobId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  readonly objectKey: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly metadata: unknown;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface CodexPetRouteDeps {
  readonly prisma?: PrismaClient;
  readonly billing?: CodexPetBilling;
  /** Must enqueue BullMQ with jobId=runId. */
  readonly enqueueRun?: (runId: string) => Promise<void>;
  /** Wakes a local/remote worker so AbortSignal and the persisted flag both take effect. */
  readonly requestCancellation?: (runId: string) => Promise<void> | void;
  /** Optional Redis notifier; database persistence remains authoritative. */
  readonly notifyRunEvent?: (runId: string) => Promise<void> | void;
  /** Optional Redis subscriber. SSE always retains database polling as a fallback. */
  readonly subscribeRunEvents?: (
    runId: string,
    onMessage: () => void,
  ) => Promise<(() => Promise<void> | void) | void>;
  readonly loadArtifact?: (objectKey: string) => Promise<Buffer>;
  /** Revalidates persisted reference bytes before a project can use them. */
  readonly validateReferenceAsset?: (asset: {
    readonly id: string;
    readonly userId: string;
    readonly objectKey: string;
    readonly mime: string;
  }) => Promise<boolean>;
  /** Legacy hard-cleanup hook for pre-soft-delete tombstones. */
  readonly enqueueProjectCleanup?: (input: { readonly userId: string; readonly projectId: string }) => Promise<void>;
  readonly artifactPreviewUrl?: (
    artifact: CodexPetArtifactShape,
    context: { readonly userId: string; readonly projectId: string },
  ) => Promise<string | null> | string | null;
  readonly signingSecret?: string;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
  readonly ssePollIntervalMs?: number;
  readonly sseHeartbeatIntervalMs?: number;
  /** Testable connection lifetime; production waits for the raw response to close. */
  readonly waitForSseDisconnect?: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Startup/start-run GPT route preflight; injectable only for isolated route tests. */
  readonly assertVisualQaReady?: () => void;
  /** Start-run GPT Image generations/edits preflight. */
  readonly assertImageReady?: () => void;
}

export type ProjectShape = {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly actionPrompts: unknown;
  readonly stylePreset: string;
  readonly styleNotes: string;
  readonly referenceAssetIds: readonly string[];
  readonly autoContinue: boolean;
  readonly imageModel: string;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
  readonly status: string;
  readonly latestRunId: string | null;
  readonly createIdempotencyKey: string | null;
  readonly deletedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type RunShape = {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly idempotencyKey: string | null;
  readonly inputSnapshot: unknown;
  readonly status: string;
  readonly progressStage: string;
  readonly progressPercent: number;
  readonly progressMessage: string | null;
  readonly autoContinue: boolean;
  readonly colorKey: string | null;
  readonly billingOperationId: string | null;
  readonly billingMode: string;
  readonly billingResourceKey: string | null;
  readonly billingReservedUnits: number;
  readonly billingSettledUnits: number;
  readonly billingReservedPoints: number;
  readonly billingSettledPoints: number;
  readonly billingSettlementStatus: string;
  readonly billingPoints: number;
  readonly billingChargeStatus: string;
  readonly billingChargeAttemptCount: number;
  readonly billingChargeError: string | null;
  readonly billingChargeNextRetryAt: Date | null;
  readonly billingChargedAt: Date | null;
  readonly billingActivatedAt: Date | null;
  readonly billingRefundedAt: Date | null;
  readonly billingRefundStatus: string;
  readonly cancelRequested: boolean;
  readonly hasSuccessfulImage: boolean;
  readonly selectedBaseArtifactId: string | null;
  readonly spritesheetArtifactId: string | null;
  readonly packageArtifactId: string | null;
  readonly previewArtifactId: string | null;
  readonly validationReport: unknown;
  readonly requestedModel: string;
  readonly visualQaModel: string;
  readonly qualityInspectionEnabled: boolean;
  readonly imageGenerationCallCount: number;
  readonly plannedImageCallLimit: number;
  readonly imageGenerationApprovalBudget: number;
  readonly pendingImageJobKey: string | null;
  readonly actualModels: readonly string[];
  readonly usage: unknown;
  readonly lastEventSequence: number;
  readonly workerId?: string | null;
  readonly error: string | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type EventShape = {
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly stage: string;
  readonly jobKey: string | null;
  readonly message: string | null;
  readonly progress: number;
  readonly payload: unknown;
  readonly createdAt: Date;
};
