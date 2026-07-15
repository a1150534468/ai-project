import type { NovelRunMode } from "../contracts.js";

export type NovelReviewReason = "qualityGateFailed" | "assistedCompletion" | "manualReviewPolicy";
export type NovelChapterReviewStatus = "pending" | "approved" | "revise";

export interface NovelReviewDecision {
  readonly requiresHumanReview: boolean;
  readonly reason: NovelReviewReason | null;
  readonly chapterReviewStatus: NovelChapterReviewStatus;
}

export function decideNovelReview(args: {
  readonly mode: NovelRunMode;
  readonly autoReview: boolean;
  readonly gatePassed: boolean;
}): NovelReviewDecision {
  if (!args.gatePassed) {
    return { requiresHumanReview: true, reason: "qualityGateFailed", chapterReviewStatus: "revise" };
  }
  if (args.mode === "assisted") {
    return { requiresHumanReview: true, reason: "assistedCompletion", chapterReviewStatus: "pending" };
  }
  if (!args.autoReview) {
    return { requiresHumanReview: true, reason: "manualReviewPolicy", chapterReviewStatus: "pending" };
  }
  return { requiresHumanReview: false, reason: null, chapterReviewStatus: "approved" };
}
