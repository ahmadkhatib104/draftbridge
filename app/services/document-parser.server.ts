import pdf from "pdf-parse";
import * as XLSX from "xlsx";
import type { ParseStatus, SourceDocumentKind } from "@prisma/client";

export interface ParsedSpreadsheetRow {
  [key: string]: string;
}

export interface ParsedDocumentContent {
  kind: SourceDocumentKind;
  extractedText: string | null;
  parseStatus: ParseStatus;
  parseError: string | null;
  pageCount: number | null;
  structuredRows: ParsedSpreadsheetRow[];
}

function toUtf8Text(contentBase64: string) {
  return Buffer.from(contentBase64, "base64").toString("utf8");
}

function normalizeCell(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return String(value).trim();
}

function rowsToPlainText(rows: ParsedSpreadsheetRow[]) {
  return rows
    .map((row, index) => {
      const cells = Object.entries(row)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" | ");

      return `ROW ${index + 1}: ${cells}`;
    })
    .join("\n");
}

function parseSpreadsheet(buffer: Buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
  });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return {
      extractedText: null,
      parseStatus: "FAILED" as const,
      parseError: "Workbook did not contain a sheet.",
      structuredRows: [],
    };
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
    defval: "",
  });
  const normalizedRows = rows.map((row) =>
    Object.fromEntries(
      Object.entries(row)
        .map(([key, value]) => [key.trim(), normalizeCell(value)])
        .filter(([key, value]) => key && value),
    ),
  );
  const extractedText = rowsToPlainText(normalizedRows);

  return {
    extractedText: extractedText || null,
    parseStatus: extractedText ? ("PARSED" as const) : ("FAILED" as const),
    parseError: extractedText ? null : "Spreadsheet did not contain structured rows.",
    structuredRows: normalizedRows,
  };
}

export async function parseDocumentContent(input: {
  kind: SourceDocumentKind;
  contentBase64?: string | null;
  textBody?: string | null;
}) {
  if (input.kind === "EMAIL_BODY" || input.kind === "TEXT") {
    const extractedText = input.textBody?.trim() || null;

    return {
      kind: input.kind,
      extractedText,
      parseStatus: extractedText ? "PARSED" : "FAILED",
      parseError: extractedText ? null : "Document body was empty.",
      pageCount: null,
      structuredRows: [],
    } satisfies ParsedDocumentContent;
  }

  if (!input.contentBase64) {
    return {
      kind: input.kind,
      extractedText: null,
      parseStatus: "FAILED",
      parseError: "Attachment body was missing.",
      pageCount: null,
      structuredRows: [],
    } satisfies ParsedDocumentContent;
  }

  const buffer = Buffer.from(input.contentBase64, "base64");

  if (input.kind === "CSV" || input.kind === "XLSX") {
    const spreadsheet = parseSpreadsheet(buffer);

    return {
      kind: input.kind,
      extractedText: spreadsheet.extractedText,
      parseStatus: spreadsheet.parseStatus,
      parseError: spreadsheet.parseError,
      pageCount: 1,
      structuredRows: spreadsheet.structuredRows,
    } satisfies ParsedDocumentContent;
  }

  if (input.kind === "PDF") {
    try {
      const parsed = await pdf(buffer);
      const extractedText = parsed.text?.trim() || null;

      return {
        kind: input.kind,
        extractedText,
        parseStatus: extractedText ? "PARSED" : "FALLBACK_REQUIRED",
        parseError: extractedText ? null : "PDF did not expose extractable text.",
        pageCount: parsed.numpages || null,
        structuredRows: [],
      } satisfies ParsedDocumentContent;
    } catch (error) {
      return {
        kind: input.kind,
        extractedText: null,
        parseStatus: "FAILED",
        parseError: error instanceof Error ? error.message : "PDF parsing failed.",
        pageCount: null,
        structuredRows: [],
      } satisfies ParsedDocumentContent;
    }
  }

  if (input.kind === "IMAGE") {
    return {
      kind: input.kind,
      extractedText: null,
      parseStatus: "FALLBACK_REQUIRED",
      parseError: "Image-only documents require AI fallback.",
      pageCount: 1,
      structuredRows: [],
    } satisfies ParsedDocumentContent;
  }

  const extractedText = toUtf8Text(input.contentBase64).trim() || null;

  return {
    kind: input.kind,
    extractedText,
    parseStatus: extractedText ? "PARSED" : "FAILED",
    parseError: extractedText ? null : "Document did not decode to readable text.",
    pageCount: null,
    structuredRows: [],
  } satisfies ParsedDocumentContent;
}

export function inferSourceDocumentKind(input: {
  filename?: string | null;
  contentType?: string | null;
  isEmailBody?: boolean;
}) {
  if (input.isEmailBody) {
    return "EMAIL_BODY" as const;
  }

  const filename = input.filename?.toLowerCase() || "";
  const contentType = input.contentType?.toLowerCase() || "";

  if (filename.endsWith(".xlsx") || contentType.includes("spreadsheet")) {
    return "XLSX" as const;
  }

  if (filename.endsWith(".csv") || contentType.includes("csv")) {
    return "CSV" as const;
  }

  if (filename.endsWith(".pdf") || contentType.includes("pdf")) {
    return "PDF" as const;
  }

  if (contentType.startsWith("image/")) {
    return "IMAGE" as const;
  }

  return "TEXT" as const;
}
