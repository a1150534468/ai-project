import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CATEGORY_KEYS, type MarketSkill } from "./types.js";

export interface MarketCategorySummary {
  key: string;
  label: string;
  total: number;
}

export interface MarketCategory {
  key: string;
  label: string;
  total: number;
  skills: MarketSkill[];
}

const categoryKeySet: ReadonlySet<string> = new Set(CATEGORY_KEYS);
const dataDir = fileURLToPath(new URL("./data", import.meta.url));

const marketSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const categorySummarySchema = z.object({
  key: z.string().min(1).refine((key) => categoryKeySet.has(key)),
  label: z.string().min(1),
  total: z.number().int().nonnegative(),
});

const categorySchema = categorySummarySchema.extend({
  skills: z.array(marketSkillSchema),
});

let categoriesCache: MarketCategorySummary[] | null = null;
const categoryCache = new Map<string, MarketCategory>();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function listMarketCategories(): MarketCategorySummary[] {
  if (!categoriesCache) {
    categoriesCache = z.array(categorySummarySchema).parse(readJson(join(dataDir, "index.json")));
  }
  return categoriesCache;
}

export function listMarketSkills(categoryKey: string): MarketCategory {
  if (!categoryKeySet.has(categoryKey)) {
    throw new Error(`UNKNOWN_CATEGORY: ${categoryKey}`);
  }
  const cached = categoryCache.get(categoryKey);
  if (cached) return cached;
  const category = categorySchema.parse(readJson(join(dataDir, `${categoryKey}.json`)));
  categoryCache.set(categoryKey, category);
  return category;
}

export function findMarketSkill(categoryKey: string, marketId: string): MarketSkill | null {
  const category = listMarketSkills(categoryKey);
  return category.skills.find((skill) => skill.id === marketId) ?? null;
}
