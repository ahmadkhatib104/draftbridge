import OpenAI from "openai";
import type { SenderProfile } from "@prisma/client";
import { z } from "zod";
import { hasOpenAiConfig } from "../lib/env.server";
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

let openAiClient: OpenAI | null = null;

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

function getOpenAiClient() {
  if (!hasOpenAiConfig()) {
    return null;
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openAiClient;
}

function coerceNullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function coerceNullableNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(/[$,]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildLowConfidenceTextExtraction(
  text: string,
  senderProfile: SenderProfile | null,
) {
  return extractedPoSchema.parse({
    poNumber: null,
    customerName: senderProfile?.customerName ?? senderProfile?.companyName ?? null,
    companyName: senderProfile?.companyName ?? null,
    contactEmail: senderProfile?.contactEmail ?? senderProfile?.senderEmail ?? null,
    currency: parseCurrencySymbol(text) ?? senderProfile?.defaultCurrency ?? "USD",
    notes: text.trim().slice(0, 500) || null,
    confidence: 0.4,
    lineItems: [],
  });
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

export async function extractTextPurchaseOrder(
  text: string,
  senderProfile: SenderProfile | null,
  modelOverride?: string,
) {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return buildLowConfidenceTextExtraction(text, senderProfile);
  }

  const client = getOpenAiClient();

  if (!client) {
    return buildLowConfidenceTextExtraction(text, senderProfile);
  }

  const response = await client.chat.completions.create({
    model: modelOverride?.trim() || process.env.OPENAI_PRIMARY_MODEL?.trim() || "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You extract purchase order details into JSON matching this exact schema:
{
  "poNumber": string | null,
  "companyName": string | null,
  "contactEmail": string | null,
  "orderDate": string | null,
  "notes": string | null,
  "lineItems": [
    {
      "merchantSku": string | null,
      "description": string,
      "quantity": number,
      "unitPrice": number,
      "uom": string
    }
  ]
}`,
      },
      {
        role: "user",
        content: `Extract from this raw PO text. Sender Email: ${
          senderProfile?.senderEmail ?? "unknown"
        }\n\n${trimmedText.slice(0, 5000)}`,
      },
    ],
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content?.trim() || "{}") as {
    poNumber?: unknown;
    companyName?: unknown;
    contactEmail?: unknown;
    orderDate?: unknown;
    notes?: unknown;
    lineItems?: unknown;
  };

  const normalizedLineItems = Array.isArray(parsed.lineItems)
    ? parsed.lineItems
        .map((lineItem) => {
          const candidate = typeof lineItem === "object" && lineItem ? lineItem : {};
          const record = candidate as Record<string, unknown>;

          return {
            customerSku: null,
            merchantSku: coerceNullableString(record.merchantSku),
            description: coerceNullableString(record.description),
            quantity: coerceNullableNumber(record.quantity),
            unitPrice: coerceNullableNumber(record.unitPrice),
            uom: coerceNullableString(record.uom),
            confidence: 0.92,
          };
        })
        .filter(
          (lineItem) =>
            lineItem.merchantSku ||
            lineItem.description ||
            lineItem.quantity ||
            lineItem.unitPrice,
        )
    : [];

  return extractedPoSchema.parse({
    poNumber: coerceNullableString(parsed.poNumber),
    customerName:
      senderProfile?.customerName ??
      coerceNullableString(parsed.companyName) ??
      senderProfile?.companyName ??
      null,
    companyName: coerceNullableString(parsed.companyName) ?? senderProfile?.companyName ?? null,
    contactEmail:
      coerceNullableString(parsed.contactEmail) ??
      senderProfile?.contactEmail ??
      senderProfile?.senderEmail ??
      null,
    currency: parseCurrencySymbol(trimmedText) ?? senderProfile?.defaultCurrency ?? "USD",
    orderDate: coerceNullableString(parsed.orderDate),
    notes: coerceNullableString(parsed.notes) ?? trimmedText.slice(0, 500),
    confidence: normalizedLineItems.length > 0 ? 0.92 : 0.4,
    lineItems: normalizedLineItems,
  });
}
