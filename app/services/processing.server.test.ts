import { describe, expect, it } from "vitest";
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
});
