import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({
  default: {},
}));

vi.mock("./audit.server", () => ({
  createAuditEvent: vi.fn(),
}));

vi.mock("./processing.server", () => ({
  processSourceDocument: vi.fn(),
}));

vi.mock("./shop.server", () => ({
  advanceOnboardingStatus: vi.fn(),
}));

vi.mock("./storage.server", () => ({
  getStoredDocumentContentBase64: vi.fn(),
  persistSourceDocumentContent: vi.fn(),
}));

import {
  assertInboundAuthenticationPassed,
  resolveInboundSender,
  scoreSourceDocumentCandidate,
} from "./intake.server";

describe("inbound intake document scoring", () => {
  it("prefers structured attachments over email body when attachments exist", () => {
    const emailBodyScore = scoreSourceDocumentCandidate({
      kind: "EMAIL_BODY",
      parseStatus: "PARSED",
      extractedText: "Please see attached purchase order.",
      hasAttachments: true,
      sequence: 0,
    });
    const csvScore = scoreSourceDocumentCandidate({
      kind: "CSV",
      parseStatus: "PARSED",
      filename: "customer-po.csv",
      extractedText: "ROW 1: PO Number: 10052 | SKU: DB-001 | Quantity: 12",
      hasAttachments: true,
      sequence: 1,
    });

    expect(csvScore).toBeGreaterThan(emailBodyScore);
  });

  it("penalizes likely supporting documents such as packing slips", () => {
    const poPdfScore = scoreSourceDocumentCandidate({
      kind: "PDF",
      parseStatus: "PARSED",
      filename: "po-10052.pdf",
      extractedText: "Purchase Order 10052",
      hasAttachments: true,
      sequence: 0,
    });
    const packingSlipScore = scoreSourceDocumentCandidate({
      kind: "PDF",
      parseStatus: "PARSED",
      filename: "packing-slip.pdf",
      extractedText: "Packing slip reference",
      hasAttachments: true,
      sequence: 1,
    });

    expect(poPdfScore).toBeGreaterThan(packingSlipScore);
  });

  it("attributes forwarded inbox mail to the original retailer sender", () => {
    const sender = resolveInboundSender({
      from: "sales@merchant.com",
      fromName: "Sales Team",
      subject: "Fwd: PO 10052",
      textBody: `---------- Forwarded message ---------
From: Retail Buyer <buyer@retailer.com>
Date: Fri, Apr 4, 2026
Subject: PO 10052
To: sales@merchant.com

Purchase Order 10052`,
    });

    expect(sender).toEqual({
      senderEmail: "buyer@retailer.com",
      senderName: "Retail Buyer",
      forwardedByEmail: "sales@merchant.com",
      source: "forwarded-body",
    });
  });

  it("prefers explicit original-sender headers when available", () => {
    const sender = resolveInboundSender({
      from: "sales@merchant.com",
      fromName: "Sales Team",
      headers: [
        {
          name: "X-Original-From",
          value: "Retail Buyer <buyer@retailer.com>",
        },
      ],
      textBody: "Purchase Order 10052",
    });

    expect(sender).toEqual({
      senderEmail: "buyer@retailer.com",
      senderName: "Retail Buyer",
      forwardedByEmail: "sales@merchant.com",
      source: "headers",
    });
  });

  it("rejects inbound emails when SPF or DKIM fail", () => {
    expect(() =>
      assertInboundAuthenticationPassed(
        {
          headers: [
            {
              name: "Authentication-Results",
              value: "mx.cloudflare.net; dkim=fail header.d=retailer.com; spf=pass",
            },
          ],
        },
        "buyer@retailer.com",
      ),
    ).toThrow(/Email spoofing detected/);
  });

  it("allows inbound emails when no authentication failure is reported", () => {
    expect(() =>
      assertInboundAuthenticationPassed(
        {
          headers: [
            {
              name: "Authentication-Results",
              value: "mx.cloudflare.net; dkim=pass header.d=retailer.com; spf=pass",
            },
          ],
        },
        "buyer@retailer.com",
      ),
    ).not.toThrow();
  });
});
