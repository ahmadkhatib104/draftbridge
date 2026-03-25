import { describe, expect, it } from "vitest";
import {
  buildDriftAlerts,
  buildValidationIssueBreakdown,
  summarizeOrders,
} from "./reporting.server";

describe("reporting helpers", () => {
  it("summarizes straight-through, review, and failure rates", () => {
    const summary = summarizeOrders([
      {
        id: "po-1",
        status: "AUTO_DRAFTED",
        createdAt: new Date("2026-03-20T00:00:00Z"),
        finalConfidence: 0.98,
        extractedConfidence: 0.96,
        sourceKind: "CSV",
        parseStatus: "PARSED",
        senderLabel: "buyer@example.com",
        validationIssues: [],
      },
      {
        id: "po-2",
        status: "OPS_REVIEW",
        createdAt: new Date("2026-03-21T00:00:00Z"),
        finalConfidence: 0.7,
        extractedConfidence: 0.82,
        sourceKind: "PDF",
        parseStatus: "PARSED",
        senderLabel: "buyer@example.com",
        validationIssues: [],
      },
      {
        id: "po-3",
        status: "FAILED",
        createdAt: new Date("2026-03-22T00:00:00Z"),
        finalConfidence: 0.2,
        extractedConfidence: 0.4,
        sourceKind: "IMAGE",
        parseStatus: "FALLBACK_REQUIRED",
        senderLabel: "buyer@example.com",
        validationIssues: [],
      },
    ]);

    expect(summary.orderCount).toBe(3);
    expect(summary.autoDraftedCount).toBe(1);
    expect(summary.reviewCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.straightThroughRate).toBeCloseTo(0.3333, 4);
    expect(summary.reviewRate).toBeCloseTo(0.3333, 4);
    expect(summary.failureRate).toBeCloseTo(0.3333, 4);
  });

  it("aggregates validation issues by code and affected orders", () => {
    const breakdown = buildValidationIssueBreakdown([
      {
        id: "po-1",
        status: "OPS_REVIEW",
        createdAt: new Date("2026-03-20T00:00:00Z"),
        finalConfidence: 0.8,
        extractedConfidence: 0.85,
        sourceKind: "PDF",
        parseStatus: "PARSED",
        senderLabel: "buyer@example.com",
        validationIssues: [
          { code: "SKU_NOT_MATCHED", blocking: true },
          { code: "SKU_NOT_MATCHED", blocking: true },
        ],
      },
      {
        id: "po-2",
        status: "OPS_REVIEW",
        createdAt: new Date("2026-03-21T00:00:00Z"),
        finalConfidence: 0.78,
        extractedConfidence: 0.83,
        sourceKind: "PDF",
        parseStatus: "PARSED",
        senderLabel: "buyer@example.com",
        validationIssues: [
          { code: "SKU_NOT_MATCHED", blocking: true },
          { code: "PRICE_MISMATCH", blocking: true },
        ],
      },
    ]);

    expect(breakdown[0]).toMatchObject({
      code: "SKU_NOT_MATCHED",
      totalCount: 3,
      orderCount: 2,
      blockingCount: 3,
    });
    expect(breakdown[1]).toMatchObject({
      code: "PRICE_MISMATCH",
      totalCount: 1,
      orderCount: 1,
      blockingCount: 1,
    });
  });

  it("raises drift alerts when straight-through drops and failures rise", () => {
    const alerts = buildDriftAlerts({
      sourceKindBreakdown: [
        {
          label: "PDF",
          current: {
            orderCount: 4,
            autoDraftedCount: 1,
            reviewCount: 2,
            failedCount: 1,
            duplicateCount: 0,
            averageFinalConfidence: 0.72,
            averageExtractedConfidence: 0.81,
            straightThroughRate: 0.25,
            reviewRate: 0.5,
            failureRate: 0.25,
          },
          prior: {
            orderCount: 4,
            autoDraftedCount: 3,
            reviewCount: 1,
            failedCount: 0,
            duplicateCount: 0,
            averageFinalConfidence: 0.92,
            averageExtractedConfidence: 0.9,
            straightThroughRate: 0.75,
            reviewRate: 0.25,
            failureRate: 0,
          },
        },
      ],
      senderBreakdown: [],
    });

    expect(alerts.some((alert) => alert.metric === "straightThroughRate")).toBe(true);
    expect(alerts.some((alert) => alert.metric === "failureRate")).toBe(true);
    expect(alerts.some((alert) => alert.metric === "averageFinalConfidence")).toBe(true);
  });
});
