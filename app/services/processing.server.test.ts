import { describe, expect, it } from "vitest";
import { parseSpreadsheetHints } from "../lib/spreadsheet-hints";
import {
  extractSpreadsheetPurchaseOrder,
  extractTextPurchaseOrder,
} from "./extraction.server";

describe("purchase order extraction", () => {
  it("extracts a po number and line items from plain text", () => {
    const result = extractTextPurchaseOrder(
      "PO 10052\nCustomer: Big Box Retail\nSKU DB-001 qty 12 price 18.00",
      null,
    );

    expect(result.poNumber).toBe("10052");
    expect(result.companyName).toBe("Big Box Retail");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]?.merchantSku).toBe("DB-001");
    expect(result.lineItems[0]?.quantity).toBe(12);
  });

  it("extracts structured spreadsheet rows", () => {
    const result = extractSpreadsheetPurchaseOrder([
      {
        "PO Number": "10052",
        Customer: "Big Box Retail",
        SKU: "DB-001",
        Quantity: "12",
        Price: "18.00",
      },
    ]);

    expect(result.poNumber).toBe("10052");
    expect(result.customerName).toBe("Big Box Retail");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0]?.merchantSku).toBe("DB-001");
    expect(result.lineItems[0]?.unitPrice).toBe(18);
  });

  it("uses sender-specific spreadsheet hints for nonstandard column names", () => {
    const result = extractSpreadsheetPurchaseOrder(
      [
        {
          Reference: "10099",
          Retailer: "Field & Supply",
          "Buyer Code": "BUY-22",
          "Units Needed": "8",
          "Net Cost": "14.50",
        },
      ],
      {
        id: "sender_1",
        shopId: "shop_1",
        senderEmail: "buyer@example.com",
        senderDomain: "example.com",
        customerName: null,
        companyName: null,
        contactEmail: null,
        defaultCurrency: "USD",
        spreadsheetHints: {
          poNumber: ["Reference"],
          customerName: ["Retailer"],
          customerSku: ["Buyer Code"],
          quantity: ["Units Needed"],
          unitPrice: ["Net Cost"],
        },
        sampleSubject: null,
        lastSeenAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );

    expect(result.poNumber).toBe("10099");
    expect(result.customerName).toBe("Field & Supply");
    expect(result.lineItems[0]?.customerSku).toBe("BUY-22");
    expect(result.lineItems[0]?.quantity).toBe(8);
    expect(result.lineItems[0]?.unitPrice).toBe(14.5);
  });

  it("normalizes spreadsheet hint JSON values", () => {
    expect(
      parseSpreadsheetHints({
        customerSku: [" Buyer SKU ", "Buyer SKU"],
        quantity: "Qty, Units",
      }),
    ).toEqual({
      customerSku: ["Buyer SKU"],
      quantity: ["Qty", "Units"],
    });
  });
});
