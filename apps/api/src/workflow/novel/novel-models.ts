function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function novelWritingModel(generationPrefs: unknown): string {
  const value = record(generationPrefs).writingModel;
  return typeof value === "string" ? value.trim() : "";
}

export function withNovelWritingModel(generationPrefs: unknown, writingModel: string): Record<string, unknown> {
  return { ...record(generationPrefs), writingModel: writingModel.trim() };
}
