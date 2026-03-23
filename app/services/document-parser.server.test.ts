import { describe, expect, it } from "vitest";
import {
  inferSourceDocumentKind,
  parseDocumentContent,
} from "./document-parser.server";

describe("document parser", () => {
  it("detects source kinds from filenames and flags", () => {
    expect(
      inferSourceDocumentKind({
        isEmailBody: true,
      }),
    ).toBe("EMAIL_BODY");
    expect(
      inferSourceDocumentKind({
        filename: "order.csv",
        contentType: "text/csv",
      }),
    ).toBe("CSV");
    expect(
      inferSourceDocumentKind({
        filename: "po.pdf",
        contentType: "application/pdf",
      }),
    ).toBe("PDF");
  });

  it("parses csv attachments into structured rows", async () => {
    const csv = "PO Number,SKU,Quantity,Price\n10052,DB-001,12,18.00";
    const parsed = await parseDocumentContent({
      kind: "CSV",
      contentBase64: Buffer.from(csv, "utf8").toString("base64"),
    });

    expect(parsed.parseStatus).toBe("PARSED");
    expect(parsed.structuredRows).toHaveLength(1);
    expect(parsed.structuredRows[0]?.SKU).toBe("DB-001");
    expect(parsed.extractedText).toContain("ROW 1");
  });
});
