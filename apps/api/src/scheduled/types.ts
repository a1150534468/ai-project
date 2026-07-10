export interface RunAgentArgs {
  readonly userId: string;
  readonly model: string;
  readonly agentId?: string | null;
  readonly prompt: string;
  readonly kbIds?: string[];
  readonly deviceId?: string | null;
}

export interface RunAgentResult {
  readonly text: string;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type RunAgentFn = (args: RunAgentArgs) => Promise<RunAgentResult>;
