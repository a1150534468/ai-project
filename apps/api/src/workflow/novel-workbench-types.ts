export interface NovelKnowledgeFactPayload {
  readonly id?: string;
  readonly chapterIndex?: number | null;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly sourceExcerpt: string;
  readonly confidence: number;
  readonly status: "confirmed" | "draft" | "conflict";
}

export interface NovelForeshadowPayload {
  readonly id?: string;
  readonly introducedInChapterIndex?: number | null;
  readonly title: string;
  readonly description: string;
  readonly expectedPayoffChapter: number;
  readonly status: "open" | "hinted" | "resolved" | "abandoned";
  readonly relatedCharacter: string;
}

export interface NovelQualityIssue {
  readonly code: string;
  readonly severity: "low" | "medium" | "high";
  readonly message: string;
  readonly suggestion: string;
}

export interface NovelQualityDiagnostics {
  readonly score: number;
  readonly tensionScore: number;
  readonly rhythmStatus: "steady" | "needs_tune" | "unstable";
  readonly styleRisk: "low" | "medium" | "high";
  readonly endingHook: boolean;
  readonly repeatedPhrases: string[];
  readonly clicheHits: string[];
  readonly issues: NovelQualityIssue[];
  readonly metrics: {
    readonly wordCount: number;
    readonly paragraphCount: number;
    readonly sentenceCount: number;
    readonly averageSentenceLength: number;
    readonly dialogueRatio: number;
    readonly questionCount: number;
    readonly exclamationCount: number;
    readonly duplicateSentenceCount: number;
  };
}

export interface NovelEventCard {
  readonly label: string;
  readonly eventType: "action" | "reveal" | "investigation" | "conflict" | "emotion" | "progress";
  readonly tensionLevel: "low" | "medium" | "high";
  readonly actors: string[];
  readonly locations: string[];
  readonly evidence: string;
}

export interface NovelMention {
  readonly name: string;
  readonly kind: "character" | "location";
  readonly count: number;
  readonly evidence: string;
}

export interface NovelChapterAssetSnapshot {
  readonly eventCards: NovelEventCard[];
  readonly characterMentions: NovelMention[];
  readonly locationMentions: NovelMention[];
}

export interface NovelConsistencyStatus {
  readonly status: "ok" | "warning";
  readonly conflicts: string[];
  readonly risks: string[];
  readonly checkedEntities: string[];
  readonly quality: NovelQualityDiagnostics;
  readonly chapterAssets: NovelChapterAssetSnapshot;
}

export interface NovelChapterSummaryPayload {
  readonly summary: string;
  readonly keyEvents: string[];
  readonly openThreads: string[];
}

export interface NovelReviewPayload {
  readonly aiReview: string;
  readonly aiActionItems: string[];
  readonly modificationRate: number;
  readonly suggestedStatus: "pending" | "approved" | "revise";
}

export interface NovelFocusCard {
  readonly chapterNumber: number;
  readonly mission: string;
  readonly conflict: string;
  readonly keyTurn: string;
  readonly emotionalNote: string;
  readonly endingHook: string;
  readonly mustKeep: string[];
  readonly mustPayoff: string[];
  readonly mustFix: string[];
  readonly avoid: string[];
}

export interface NovelMicroBeat {
  readonly index: number;
  readonly label: string;
  readonly focus: "sensory" | "dialogue" | "action" | "emotion";
  readonly objective: string;
  readonly targetWords: number;
}

export interface NovelContinuityAlert {
  readonly level: "info" | "warning" | "critical";
  readonly title: string;
  readonly detail: string;
}

export interface NovelWorkflowGateReason {
  readonly code: string;
  readonly level: "info" | "warning" | "critical";
  readonly title: string;
  readonly detail: string;
}

export interface NovelWorkflowGate {
  readonly allowed: boolean;
  readonly status: "ok" | "warning" | "blocked";
  readonly summary: string;
  readonly checkedChapter: {
    readonly id: string;
    readonly chapterIndex: number;
    readonly title: string;
    readonly status: string;
    readonly reviewStatus: string;
    readonly modificationRate: number;
  } | null;
  readonly blockingReasons: NovelWorkflowGateReason[];
  readonly warnings: NovelWorkflowGateReason[];
  readonly minimumModificationRate: number;
}

export interface NovelGenerationContextPayload {
  readonly project: {
    readonly id: string;
    readonly title: string;
    readonly genre: string;
  };
  readonly chapterNumber: number;
  readonly chapterGoal: string;
  readonly contextLayers: {
    readonly foundation: string[];
    readonly continuity: string[];
    readonly tactical: string[];
  };
  readonly focusCard: NovelFocusCard;
  readonly microBeats: NovelMicroBeat[];
  readonly continuityAlerts: NovelContinuityAlert[];
  readonly workflowGate: NovelWorkflowGate;
  readonly knowledgeFacts: NovelKnowledgeFactPayload[];
  readonly foreshadowItems: NovelForeshadowPayload[];
  readonly recentSummaries: NovelChapterSummaryPayload[];
  readonly styleProfile: {
    readonly content: string;
    readonly structuredData: Record<string, unknown>;
  };
}
