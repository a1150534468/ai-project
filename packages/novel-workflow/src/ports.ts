import type { NovelPipelineStepKind, NovelRunEvent, NovelRunSnapshot } from "./contracts.js";

export interface NovelEventPublisher {
  publish(event: NovelRunEvent): Promise<void>;
}

export interface NovelRunRepository {
  getRun(runId: string): Promise<NovelRunSnapshot | null>;
  claimStep(stepId: string, workerId: string): Promise<boolean>;
  completeStep(stepId: string, output: Record<string, unknown>): Promise<void>;
  failStep(stepId: string, error: string): Promise<void>;
}

export interface NovelGenerationPort {
  generate(input: {
    readonly runId: string;
    readonly stepId: string;
    readonly kind: NovelPipelineStepKind;
    readonly prompt: string;
    readonly maxTokens: number;
    readonly onChunk?: (chunk: string) => Promise<void>;
  }): Promise<{ readonly text: string; readonly model: string; readonly inputTokens: number; readonly outputTokens: number }>;
}
