import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({
  default: {},
}));

import {
  buildMerchantExceptionWhere,
  describeMerchantExceptionState,
  summarizeMerchantExceptions,
} from "./merchant-exceptions.server";

describe("merchant exception queue", () => {
  it("captures the merchant-visible unresolved states", () => {
    expect(buildMerchantExceptionWhere("shop-1")).toEqual({
      shopId: "shop-1",
      OR: [
        {
          status: {
            in: ["OPS_REVIEW", "DUPLICATE"],
          },
        },
        {
          clarificationNeeded: true,
        },
        {
          opsCase: {
            is: {
              status: {
                in: ["OPEN", "IN_PROGRESS", "WAITING_ON_MERCHANT"],
              },
            },
          },
        },
      ],
    });
  });

  it("summarizes waiting, review, duplicate, and blocking counts", () => {
    const summary = summarizeMerchantExceptions([
      {
        status: "OPS_REVIEW",
        clarificationNeeded: true,
        validationIssues: [{ blocking: true }],
        opsCase: { status: "WAITING_ON_MERCHANT" },
      },
      {
        status: "OPS_REVIEW",
        clarificationNeeded: false,
        validationIssues: [{ blocking: true }],
        opsCase: { status: "OPEN" },
      },
      {
        status: "DUPLICATE",
        clarificationNeeded: false,
        validationIssues: [],
        opsCase: { status: "IN_PROGRESS" },
      },
    ]);

    expect(summary).toEqual({
      totalCount: 3,
      waitingOnMerchantCount: 1,
      underReviewCount: 2,
      duplicateCount: 1,
      blockingIssueCount: 2,
    });
  });

  it("describes queue state for merchant copy", () => {
    expect(
      describeMerchantExceptionState({
        status: "OPS_REVIEW",
        clarificationNeeded: true,
        opsCaseStatus: "WAITING_ON_MERCHANT",
        blockingIssueCount: 1,
      }),
    ).toBe("Needs your clarification");
    expect(
      describeMerchantExceptionState({
        status: "DUPLICATE",
        clarificationNeeded: false,
        opsCaseStatus: "IN_PROGRESS",
      }),
    ).toBe("Duplicate PO under review");
    expect(
      describeMerchantExceptionState({
        status: "OPS_REVIEW",
        clarificationNeeded: false,
        opsCaseStatus: "OPEN",
        blockingIssueCount: 2,
      }),
    ).toBe("Validation issue under review");
  });
});
