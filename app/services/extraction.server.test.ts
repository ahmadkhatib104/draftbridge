import { beforeEach, describe, expect, it, vi } from "vitest";

const createCompletion = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: createCompletion,
      },
    },
  })),
}));

import { extractTextPurchaseOrder } from "./extraction.server";

describe("text purchase order extraction", () => {
  beforeEach(() => {
    createCompletion.mockReset();
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OPENAI_PRIMARY_MODEL;
  });

  it("extracts structured purchase-order JSON through OpenAI", async () => {
    createCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              poNumber: "PO-1042",
              companyName: "Retail Buyer Co",
              contactEmail: "buyer@retailer.com",
              orderDate: "2026-04-04",
              notes: "Rush delivery",
              lineItems: [
                {
                  merchantSku: "DB-001",
                  description: "Sparkling Water 12-pack",
                  quantity: 12,
                  unitPrice: 18.5,
                  uom: "case",
                },
              ],
            }),
          },
        },
      ],
    });

    const extracted = await extractTextPurchaseOrder("PO 1042 raw text", {
      id: "sender-1",
      shopId: "shop-1",
      senderEmail: "buyer@retailer.com",
      senderDomain: "retailer.com",
      customerName: null,
      companyName: "Retail Buyer Co",
      contactEmail: "buyer@retailer.com",
      defaultCurrency: "USD",
      spreadsheetHints: null,
      sampleSubject: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(createCompletion).toHaveBeenCalledOnce();
    expect(extracted).toMatchObject({
      poNumber: "PO-1042",
      companyName: "Retail Buyer Co",
      contactEmail: "buyer@retailer.com",
      currency: "USD",
      confidence: 0.92,
    });
    expect(extracted.lineItems).toEqual([
      expect.objectContaining({
        merchantSku: "DB-001",
        quantity: 12,
        unitPrice: 18.5,
        uom: "case",
        confidence: 0.92,
      }),
    ]);
  });

  it("falls back to a low-confidence empty extraction when OpenAI is not configured", async () => {
    delete process.env.OPENAI_API_KEY;

    const extracted = await extractTextPurchaseOrder("PO text without config", null);

    expect(extracted.confidence).toBe(0.4);
    expect(extracted.lineItems).toEqual([]);
  });
});
