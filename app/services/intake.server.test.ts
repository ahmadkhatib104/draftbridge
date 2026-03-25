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

import { scoreSourceDocumentCandidate } from "./intake.server";

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
});
