import type { SenderProfile } from "@prisma/client";
import { z } from "zod";
import {
  parseSpreadsheetHints,
  type SpreadsheetHintKey,
} from "../lib/spreadsheet-hints";
import type { ParsedSpreadsheetRow } from "./document-parser.server";

const extractedLineSchema = z.object({
  customerSku: z.string().optional().nullable(),
  merchantSku: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  quantity: z.number().int().positive().optional().nullable(),
  unitPrice: z.number().nonnegative().optional().nullable(),
  uom: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
});

export const extractedPoSchema = z.object({
  poNumber: z.string().optional().nullable(),
  customerName: z.string().optional().nullable(),
  companyName: z.string().optional().nullable(),
  contactEmail: z.string().email().optional().nullable(),
  currency: z.string().optional().nullable(),
  orderDate: z.string().optional().nullable(),
  shipToName: z.string().optional().nullable(),
  shipToAddress: z.string().optional().nullable(),
  billToName: z.string().optional().nullable(),
  billToAddress: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
  lineItems: z.array(extractedLineSchema).default([]),
});

export type ExtractedPurchaseOrder = z.infer<typeof extractedPoSchema>;

export function normalizeValue(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function parseCurrencySymbol(text: string) {
  if (text.includes("$")) {
    return "USD";
  }

  return null;
}

function detectRowColumn(headers: string[], variants: string[]) {
  return headers.find((header) =>
    variants.some((variant) => normalizeValue(header) === normalizeValue(variant)),
  );
}

function detectRowColumnWithHints(
  headers: string[],
  defaults: string[],
  senderProfile?: SenderProfile | null,
  hintKey?: SpreadsheetHintKey,
) {
  const parsedHints = senderProfile ? parseSpreadsheetHints(senderProfile.spreadsheetHints) : {};
  const hintVariants = hintKey ? parsedHints[hintKey] ?? [] : [];

  return detectRowColumn(headers, [...hintVariants, ...defaults]);
}

export function extractSpreadsheetPurchaseOrder(
  rows: ParsedSpreadsheetRow[],
  senderProfile?: SenderProfile | null,
) {
  const headers = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row).filter(Boolean))),
  );
  const skuKey = detectRowColumnWithHints(
    headers,
    ["sku", "item sku", "merchant sku", "vendor sku", "product sku"],
    senderProfile,
    "merchantSku",
  );
  const customerSkuKey = detectRowColumnWithHints(
    headers,
    ["customer sku", "buyer sku"],
    senderProfile,
    "customerSku",
  );
  const descriptionKey = detectRowColumnWithHints(
    headers,
    ["description", "item description", "product", "item"],
    senderProfile,
    "description",
  );
  const quantityKey = detectRowColumnWithHints(
    headers,
    ["qty", "quantity", "order qty", "units"],
    senderProfile,
    "quantity",
  );
  const priceKey = detectRowColumnWithHints(
    headers,
    ["price", "unit price", "wholesale price", "cost"],
    senderProfile,
    "unitPrice",
  );
  const uomKey = detectRowColumnWithHints(
    headers,
    ["uom", "unit", "unit of measure"],
    senderProfile,
    "uom",
  );
  const poKey = detectRowColumnWithHints(
    headers,
    ["po", "po number", "purchase order", "purchase order number"],
    senderProfile,
    "poNumber",
  );
  const customerKey = detectRowColumnWithHints(
    headers,
    ["customer", "customer name", "account", "retailer"],
    senderProfile,
    "customerName",
  );
  const companyKey = detectRowColumnWithHints(
    headers,
    ["company", "company name"],
    senderProfile,
    "companyName",
  );
  const contactEmailKey = detectRowColumnWithHints(
    headers,
    ["email", "contact email", "buyer email"],
    senderProfile,
    "contactEmail",
  );

  const lineItems = rows
    .map((row) => ({
      customerSku: customerSkuKey ? row[customerSkuKey] || null : null,
      merchantSku: skuKey ? row[skuKey] || null : null,
      description: descriptionKey ? row[descriptionKey] || null : null,
      quantity: quantityKey ? Number(row[quantityKey]) || null : null,
      unitPrice: priceKey ? Number(row[priceKey]) || null : null,
      uom: uomKey ? row[uomKey] || null : null,
      confidence: 0.96,
    }))
    .filter(
      (lineItem) =>
        lineItem.merchantSku ||
        lineItem.customerSku ||
        lineItem.description ||
        lineItem.quantity ||
        lineItem.unitPrice,
    );

  return extractedPoSchema.parse({
    poNumber: poKey ? rows[0]?.[poKey] || null : null,
    customerName: customerKey ? rows[0]?.[customerKey] || null : null,
    companyName: companyKey ? rows[0]?.[companyKey] || null : null,
    contactEmail:
      (contactEmailKey ? rows[0]?.[contactEmailKey] || null : null) ??
      senderProfile?.contactEmail ??
      senderProfile?.senderEmail ??
      null,
    currency: "USD",
    confidence: lineItems.length > 0 ? 0.96 : 0.5,
    lineItems,
  });
}

export function extractTextPurchaseOrder(text: string, senderProfile: SenderProfile | null) {
  const poNumber =
    text.match(/(?:po(?: number)?|purchase order|order)[#:\s-]*([a-z0-9-]+)/i)?.[1] ??
    null;
  const contactEmail =
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ??
    senderProfile?.contactEmail ??
    senderProfile?.senderEmail ??
    null;
  const companyName =
    text.match(/(?:customer|company|account)[:\s]+(.+)/i)?.[1]?.split("\n")[0]?.trim() ??
    senderProfile?.companyName ??
    null;
  const currency = parseCurrencySymbol(text) ?? senderProfile?.defaultCurrency ?? "USD";

  const lineItems = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const usesQuantityPattern = /qty|quantity/i.test(line);
      const regexMatch =
        line.match(
          /(?:sku[:#\s-]*([A-Z0-9._-]+))?.*?(?:qty|quantity)[:\s]*([0-9]+).*?(?:price|unit price)?[:\s$]*([0-9]+(?:\.[0-9]{1,2})?)/i,
        ) ||
        line.match(/([A-Z0-9._-]{3,})\s+(.+?)\s+([0-9]+)\s+\$?([0-9]+(?:\.[0-9]{1,2})?)$/i);

      if (!regexMatch) {
        return null;
      }

      if (usesQuantityPattern) {
        return {
          merchantSku: regexMatch[1] || null,
          customerSku: null,
          description: line,
          quantity: Number(regexMatch[2]) || null,
          unitPrice: Number(regexMatch[3]) || null,
          uom: "each",
          confidence: 0.72,
        };
      }

      return {
        merchantSku: regexMatch[1] || null,
        customerSku: null,
        description: regexMatch[2] || line,
        quantity: Number(regexMatch[3]) || null,
        unitPrice: Number(regexMatch[4]) || null,
        uom: "each",
        confidence: 0.74,
      };
    })
    .filter((lineItem): lineItem is NonNullable<typeof lineItem> => Boolean(lineItem));

  return extractedPoSchema.parse({
    poNumber,
    customerName: companyName,
    companyName,
    contactEmail,
    currency,
    orderDate:
      text.match(/(?:date|order date)[:\s]+([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i)?.[1] ??
      null,
    shipToName:
      text.match(/ship to[:\s]+(.+)/i)?.[1]?.split("\n")[0]?.trim() ?? null,
    billToName:
      text.match(/bill to[:\s]+(.+)/i)?.[1]?.split("\n")[0]?.trim() ?? null,
    notes: text.slice(0, 500),
    confidence: lineItems.length > 0 ? 0.72 : 0.42,
    lineItems,
  });
}
