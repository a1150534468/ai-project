export type MemoryType = "CORE" | "PERMANENT" | "TEMPORARY" | "KNOWLEDGE" | "OTHER";

export type MemoryNode = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly type: MemoryType;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly usedCount: number;
};

export type MemoryGalaxyData = {
  readonly enabled: boolean;
  readonly stats: {
    readonly total: number;
    readonly byType: Readonly<Record<MemoryType, number>>;
  };
  readonly nodes: readonly MemoryNode[];
};

export type MemoryDraft = {
  readonly title: string;
  readonly text: string;
  readonly type: MemoryType;
  readonly importance: number;
  readonly tags: readonly string[];
};
