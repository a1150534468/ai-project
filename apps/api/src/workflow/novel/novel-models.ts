export interface NovelPlatformModel {
  readonly model: string;
  readonly enabled: boolean;
  readonly tags?: string;
  readonly showInMarketplace?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tags(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean));
}

export function novelWritingModel(generationPrefs: unknown): string {
  const value = record(generationPrefs).writingModel;
  return typeof value === "string" ? value.trim() : "";
}

export function withNovelWritingModel(generationPrefs: unknown, writingModel: string): Record<string, unknown> {
  return { ...record(generationPrefs), writingModel: writingModel.trim() };
}

export function supportsNovelGeneration(model: NovelPlatformModel): boolean {
  const capabilities = tags(model.tags);
  return model.enabled
    && !model.model.toLowerCase().includes("embedding")
    && !capabilities.has("openai-only");
}

export function findEnabledNovelModel(rows: readonly NovelPlatformModel[], model: string): NovelPlatformModel | null {
  const normalized = model.trim();
  return rows.find((row) => row.model === normalized && supportsNovelGeneration(row)) ?? null;
}
