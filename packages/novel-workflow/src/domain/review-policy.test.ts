import { describe, expect, it } from "vitest";
import { decideNovelReview } from "./review-policy.js";

describe("novel review policy", () => {
  it("requires routine human confirmation for assisted writing", () => {
    expect(decideNovelReview({ mode: "assisted", autoReview: false, gatePassed: true })).toEqual({
      requiresHumanReview: true,
      reason: "assistedCompletion",
      chapterReviewStatus: "pending",
    });
  });

  it("continues automatically only when autopilot and auto review are both enabled", () => {
    expect(decideNovelReview({ mode: "autopilot", autoReview: true, gatePassed: true })).toEqual({
      requiresHumanReview: false,
      reason: null,
      chapterReviewStatus: "approved",
    });
  });

  it("waits for human confirmation when autopilot auto review is disabled", () => {
    expect(decideNovelReview({ mode: "autopilot", autoReview: false, gatePassed: true })).toEqual({
      requiresHumanReview: true,
      reason: "manualReviewPolicy",
      chapterReviewStatus: "pending",
    });
  });

  it("marks a failed quality gate for revision in every mode", () => {
    expect(decideNovelReview({ mode: "autopilot", autoReview: true, gatePassed: false })).toEqual({
      requiresHumanReview: true,
      reason: "qualityGateFailed",
      chapterReviewStatus: "revise",
    });
  });
});
