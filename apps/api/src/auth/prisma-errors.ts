interface PrismaErrorShape {
  readonly code?: unknown;
  readonly meta?: unknown;
}

export function uniqueConstraintTargets(error: unknown): readonly string[] | null {
  if (!error || typeof error !== "object" || (error as PrismaErrorShape).code !== "P2002") return null;
  const meta = (error as PrismaErrorShape).meta;
  if (!meta || typeof meta !== "object" || !("target" in meta)) return [];
  const target = meta.target;
  if (typeof target === "string") return [target];
  if (!Array.isArray(target)) return [];
  return target.filter((value): value is string => typeof value === "string");
}

export function isUniqueConstraintOn(error: unknown, field: string): boolean {
  return uniqueConstraintTargets(error)?.some((target) => target === field || target.includes(field)) ?? false;
}
