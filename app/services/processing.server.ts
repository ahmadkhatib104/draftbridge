import OpenAI from "openai";
import type {
  SenderProfile,
  SourceDocument,
  ValidationSeverity,
} from "@prisma/client";
import db from "../db.server";
import { hasOpenAiConfig } from "../lib/env.server";
import { createAuditEvent } from "./audit.server";
import type { ParsedSpreadsheetRow } from "./document-parser.server";
import {
  extractedPoSchema,
  extractSpreadsheetPurchaseOrder,
  extractTextPurchaseOrder,
  normalizeValue,
  type ExtractedPurchaseOrder,
} from "./extraction.server";
import { searchCustomers, searchProductVariants, createDraftOrder } from "./shopify-admin.server";

const AUTO_CREATE_THRESHOLD = 0.92;
const RETRY_THRESHOLD = 0.75;
const PRICE_TOLERANCE = 0.02;

function parseDateValue(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function averageConfidence(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function extractWithOpenAi(input: {
  text: string;
  model: string;
}) {
  if (!hasOpenAiConfig()) {
    return null;
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  const completion = await client.chat.completions.create({
    model: input.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extract a wholesale purchase order into JSON with poNumber, customerName, companyName, contactEmail, currency, orderDate, shipToName, shipToAddress, billToName, billToAddress, notes, confidence, and lineItems with customerSku, merchantSku, description, quantity, unitPrice, uom, confidence. Use null when unknown.",
      },
      {
        role: "user",
        content: input.text.slice(0, 12000),
      },
    ],
  });
  const content = completion.choices[0]?.message?.content?.trim();

  if (!content) {
    return null;
  }

  return extractedPoSchema.parse(JSON.parse(content));
}

async function extractCandidatePurchaseOrder(input: {
  sourceDocument: SourceDocument;
  senderProfile: SenderProfile | null;
  structuredRows: ParsedSpreadsheetRow[];
}) {
  const extractedText = input.sourceDocument.extractedText?.trim() || "";
  let candidate =
    input.structuredRows.length > 0
      ? extractSpreadsheetPurchaseOrder(input.structuredRows, input.senderProfile)
      : extractTextPurchaseOrder(extractedText, input.senderProfile);

  if (
    candidate.lineItems.length === 0 ||
    (candidate.confidence ?? 0) < RETRY_THRESHOLD
  ) {
    const openAiCandidate = await extractWithOpenAi({
      text: extractedText,
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-4o-mini",
    });

    if (openAiCandidate && (openAiCandidate.lineItems.length > candidate.lineItems.length)) {
      candidate = openAiCandidate;
    }
  }

  return candidate;
}

async function findCustomerMatch(shopId: string, shopDomain: string, candidate: ExtractedPurchaseOrder) {
  const aliases = await db.customerAlias.findMany({
    where: {
      shopId,
      normalizedValue: {
        in: [
          normalizeValue(candidate.contactEmail),
          normalizeValue(candidate.companyName),
          normalizeValue(candidate.customerName),
        ].filter(Boolean),
      },
    },
  });

  const alias = aliases.find((entry) => entry.customerId || entry.companyLocationId || entry.companyId);

  if (alias?.customerId) {
    return {
      customerId: alias.customerId,
      companyId: alias.companyId,
      companyLocationId: alias.companyLocationId,
      confidence: 0.97,
    };
  }

  const searchTerm = candidate.contactEmail || candidate.companyName || candidate.customerName || "";
  const customers = await searchCustomers(shopDomain, searchTerm);

  if (customers.length === 1) {
    return {
      customerId: customers[0].legacyId,
      companyId: null,
      companyLocationId: alias?.companyLocationId ?? null,
      confidence: candidate.contactEmail ? 0.93 : 0.84,
    };
  }

  if (candidate.contactEmail) {
    return {
      customerId: null,
      companyId: alias?.companyId ?? null,
      companyLocationId: alias?.companyLocationId ?? null,
      confidence: 0.9,
    };
  }

  return {
    customerId: null,
    companyId: alias?.companyId ?? null,
    companyLocationId: alias?.companyLocationId ?? null,
    confidence: 0.4,
  };
}

async function findVariantMatch(input: {
  shopId: string;
  shopDomain: string;
  senderProfileId?: string | null;
  lineItem: {
    customerSku?: string | null;
    merchantSku?: string | null;
    description?: string | null;
  };
}) {
  const normalizedCustomerSku = normalizeValue(input.lineItem.customerSku);
  const normalizedDescription = normalizeValue(input.lineItem.description);
  const aliasFilters: Array<{
    aliasType: "CUSTOMER_SKU" | "DESCRIPTION";
    normalizedValue: string;
  }> = [];

  if (normalizedCustomerSku) {
    aliasFilters.push({
      aliasType: "CUSTOMER_SKU",
      normalizedValue: normalizedCustomerSku,
    });
  }

  if (normalizedDescription) {
    aliasFilters.push({
      aliasType: "DESCRIPTION",
      normalizedValue: normalizedDescription,
    });
  }

  const alias = await db.catalogAlias.findFirst({
    where: {
      shopId: input.shopId,
      senderProfileId: input.senderProfileId ?? null,
      OR: aliasFilters,
    },
  });

  if (alias) {
    return {
      variantId: alias.variantId,
      matchedSku: alias.sku,
      matchedTitle: alias.title,
      price: null,
      confidence: 0.98,
    };
  }

  const searchTerms = [
    input.lineItem.merchantSku,
    input.lineItem.customerSku,
    input.lineItem.description,
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const term of searchTerms) {
    const variants = await searchProductVariants(input.shopDomain, term);
    if (variants.length === 1) {
      const variant = variants[0];
      return {
        variantId: variant.legacyId,
        matchedSku: variant.sku,
        matchedTitle: `${variant.productTitle} / ${variant.title}`,
        price: variant.price,
        confidence: term === input.lineItem.merchantSku ? 0.95 : 0.82,
      };
    }
  }

  return {
    variantId: null,
    matchedSku: null,
    matchedTitle: null,
    price: null,
    confidence: 0.25,
  };
}

function priceDiffPercent(expectedPrice: number | null, actualPrice: number | null) {
  if (expectedPrice === null || actualPrice === null || expectedPrice === 0) {
    return 0;
  }

  return Math.abs(expectedPrice - actualPrice) / expectedPrice;
}

async function createOpsCase(input: {
  shopId: string;
  purchaseOrderId: string;
  summary: string;
}) {
  const opsCase = await db.opsCase.upsert({
    where: { purchaseOrderId: input.purchaseOrderId },
    update: {
      status: "OPEN",
      summary: input.summary,
      resolvedAt: null,
    },
    create: {
      shopId: input.shopId,
      purchaseOrderId: input.purchaseOrderId,
      summary: input.summary,
    },
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: input.purchaseOrderId,
    opsCaseId: opsCase.id,
    entityType: "OPS_CASE",
    entityId: opsCase.id,
    action: "OPS_CASE_OPENED",
    summary: input.summary,
  });

  return opsCase;
}

export async function processSourceDocument(input: {
  shopId: string;
  shopDomain: string;
  inboundMessageId: string;
  mailboxId: string;
  senderProfile: SenderProfile | null;
  sourceDocument: SourceDocument;
  structuredRows: ParsedSpreadsheetRow[];
}) {
  const candidate = await extractCandidatePurchaseOrder({
    sourceDocument: input.sourceDocument,
    senderProfile: input.senderProfile,
    structuredRows: input.structuredRows,
  });

  const parsedOrderDate = parseDateValue(candidate.orderDate);
  const duplicate =
    candidate.poNumber
      ? await db.purchaseOrder.findFirst({
          where: {
            shopId: input.shopId,
            poNumber: candidate.poNumber,
            sourceDocumentId: {
              not: input.sourceDocument.id,
            },
          },
          select: { id: true },
        })
      : null;

  const purchaseOrder = await db.purchaseOrder.create({
    data: {
      shopId: input.shopId,
      inboundMessageId: input.inboundMessageId,
      sourceDocumentId: input.sourceDocument.id,
      mailboxId: input.mailboxId,
      senderProfileId: input.senderProfile?.id ?? undefined,
      poNumber: candidate.poNumber ?? undefined,
      customerName: candidate.customerName ?? undefined,
      companyName: candidate.companyName ?? undefined,
      contactEmail: candidate.contactEmail ?? undefined,
      currency: candidate.currency ?? undefined,
      orderDate: parsedOrderDate ?? undefined,
      shipToName: candidate.shipToName ?? undefined,
      shipToAddress: candidate.shipToAddress ?? undefined,
      billToName: candidate.billToName ?? undefined,
      billToAddress: candidate.billToAddress ?? undefined,
      notes: candidate.notes ?? undefined,
      extractedConfidence: candidate.confidence ?? 0,
      status: duplicate ? "DUPLICATE" : "EXTRACTED",
      lineItems: {
        create: candidate.lineItems.map((lineItem, index) => ({
          lineNumber: index + 1,
          customerSku: lineItem.customerSku ?? undefined,
          merchantSku: lineItem.merchantSku ?? undefined,
          description: lineItem.description ?? undefined,
          quantity: lineItem.quantity ?? undefined,
          unitPrice: lineItem.unitPrice ?? undefined,
          uom: lineItem.uom ?? undefined,
          extractedConfidence: lineItem.confidence ?? candidate.confidence ?? 0,
        })),
      },
    },
    include: {
      lineItems: true,
    },
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: purchaseOrder.id,
    entityType: "PURCHASE_ORDER",
    entityId: purchaseOrder.id,
    action: "PURCHASE_ORDER_EXTRACTED",
    summary: `Extracted a candidate purchase order from ${input.sourceDocument.filename ?? input.sourceDocument.kind.toLowerCase()}.`,
  });

  const validationIssues: Array<{
    lineItemId?: string;
    severity: ValidationSeverity;
    code: string;
    message: string;
    blocking: boolean;
  }> = [];

  if (duplicate) {
    validationIssues.push({
      severity: "ERROR",
      code: "DUPLICATE_PO_NUMBER",
      message: `PO ${candidate.poNumber} already exists for this shop.`,
      blocking: true,
    });
  }

  const customerMatch = await findCustomerMatch(
    input.shopId,
    input.shopDomain,
    candidate,
  );

  if (!customerMatch.customerId) {
    validationIssues.push({
      severity: "WARNING",
      code: "CUSTOMER_NOT_CONFIRMED",
      message: "Could not confidently match a Shopify customer for this sender.",
      blocking: false,
    });
  }

  const lineConfidence: number[] = [];
  const matchedLines = [];

  for (const lineItem of purchaseOrder.lineItems) {
    const match = await findVariantMatch({
      shopId: input.shopId,
      shopDomain: input.shopDomain,
      senderProfileId: input.senderProfile?.id,
      lineItem,
    });
    const quantity = lineItem.quantity ?? 0;
    const unitPrice = lineItem.unitPrice ? Number(lineItem.unitPrice) : null;

    let validationStatus: "MATCHED" | "REVIEW_REQUIRED" | "INVALID" = "MATCHED";
    const lineIssues = [];

    if (!quantity || quantity < 1) {
      lineIssues.push({
        severity: "ERROR" as const,
        code: "INVALID_QUANTITY",
        message: `Line ${lineItem.lineNumber} has an invalid quantity.`,
        blocking: true,
      });
      validationStatus = "INVALID";
    }

    if (!match.variantId) {
      lineIssues.push({
        severity: "ERROR" as const,
        code: "SKU_NOT_MATCHED",
        message: `Line ${lineItem.lineNumber} could not be matched to a Shopify variant.`,
        blocking: true,
      });
      validationStatus = "REVIEW_REQUIRED";
    }

    if (
      match.price !== null &&
      unitPrice !== null &&
      priceDiffPercent(match.price, unitPrice) > PRICE_TOLERANCE
    ) {
      lineIssues.push({
        severity: "ERROR" as const,
        code: "PRICE_MISMATCH",
        message: `Line ${lineItem.lineNumber} price ${unitPrice.toFixed(2)} does not match Shopify price ${match.price.toFixed(2)} within tolerance.`,
        blocking: true,
      });
      validationStatus = "REVIEW_REQUIRED";
    }

    if (unitPrice === null && match.price !== null) {
      lineIssues.push({
        severity: "WARNING" as const,
        code: "MISSING_UNIT_PRICE",
        message: `Line ${lineItem.lineNumber} did not include a unit price; Shopify default pricing will be used if auto-created.`,
        blocking: false,
      });
    }

    await db.purchaseOrderLine.update({
      where: { id: lineItem.id },
      data: {
        validationStatus,
        matchedVariantId: match.variantId ?? undefined,
        matchedSku: match.matchedSku ?? undefined,
        matchedTitle: match.matchedTitle ?? undefined,
        matchConfidence: match.confidence,
      },
    });

    for (const issue of lineIssues) {
      validationIssues.push({
        lineItemId: lineItem.id,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        blocking: issue.blocking,
      });
    }

    lineConfidence.push(
      averageConfidence([
        lineItem.extractedConfidence,
        match.confidence,
      ]),
    );

    matchedLines.push({
      lineNumber: lineItem.lineNumber,
      variantLegacyId: match.variantId,
      quantity,
      originalUnitPrice:
        unitPrice !== null ? unitPrice.toFixed(2) : match.price?.toFixed(2) ?? null,
    });
  }

  if (purchaseOrder.lineItems.length === 0) {
    validationIssues.push({
      severity: "ERROR",
      code: "NO_LINE_ITEMS",
      message: "No order lines could be extracted from this document.",
      blocking: true,
    });
  }

  if (candidate.confidence !== null && candidate.confidence !== undefined) {
    lineConfidence.push(candidate.confidence);
  }

  const finalConfidence = averageConfidence([
    customerMatch.confidence,
    ...lineConfidence,
  ]);
  const hasBlockingIssues = validationIssues.some((issue) => issue.blocking);

  if (validationIssues.length > 0) {
    await db.validationIssue.createMany({
      data: validationIssues.map((issue) => ({
        shopId: input.shopId,
        purchaseOrderId: purchaseOrder.id,
        lineItemId: issue.lineItemId,
        severity: issue.severity,
        code: issue.code,
        message: issue.message,
        blocking: issue.blocking,
      })),
    });
  }

  const nextStatus =
    hasBlockingIssues || finalConfidence < AUTO_CREATE_THRESHOLD
      ? duplicate
        ? "DUPLICATE"
        : "OPS_REVIEW"
      : "VALIDATED";

  const updatedOrder = await db.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: {
      status: nextStatus,
      finalConfidence,
      matchedCustomerId: customerMatch.customerId ?? undefined,
      matchedCompanyId: customerMatch.companyId ?? undefined,
      matchedCompanyLocationId: customerMatch.companyLocationId ?? undefined,
      clarificationNeeded: hasBlockingIssues || !customerMatch.customerId,
    },
    include: {
      lineItems: true,
    },
  });

  if (hasBlockingIssues || finalConfidence < AUTO_CREATE_THRESHOLD) {
    await createOpsCase({
      shopId: input.shopId,
      purchaseOrderId: purchaseOrder.id,
      summary:
        finalConfidence < AUTO_CREATE_THRESHOLD
          ? "Purchase order needs manual review before draft-order creation."
          : "Purchase order contains blocking validation issues.",
    });

    return updatedOrder;
  }

  try {
    const draftOrder = await createDraftOrder({
      shopDomain: input.shopDomain,
      customerLegacyId: customerMatch.customerId,
      contactEmail: candidate.contactEmail,
      poNumber: candidate.poNumber,
      note: candidate.notes,
      lineItems: matchedLines
        .filter((lineItem) => lineItem.variantLegacyId)
        .map((lineItem) => ({
          variantLegacyId: lineItem.variantLegacyId!,
          quantity: lineItem.quantity,
          originalUnitPrice: lineItem.originalUnitPrice,
        })),
    });

    await db.draftOrderSync.create({
      data: {
        shopId: input.shopId,
        purchaseOrderId: purchaseOrder.id,
        status: "CREATED",
        shopifyDraftOrderId: String(draftOrder.id),
        shopifyDraftOrderName: draftOrder.name,
      },
    });

    await db.usageLedger.create({
      data: {
        shopId: input.shopId,
        purchaseOrderId: purchaseOrder.id,
        eventType:
          finalConfidence <= 1
            ? "INCLUDED_SUCCESS"
            : "OVERAGE_SUCCESS",
      },
    });

    await db.purchaseOrder.update({
      where: { id: purchaseOrder.id },
      data: {
        status: "AUTO_DRAFTED",
        billableSuccessAt: new Date(),
      },
    });

    await createAuditEvent({
      shopId: input.shopId,
      purchaseOrderId: purchaseOrder.id,
      entityType: "DRAFT_ORDER",
      entityId: String(draftOrder.id),
      action: "DRAFT_ORDER_CREATED",
      summary: `Created Shopify draft order ${draftOrder.name}.`,
      metadata: {
        shopifyDraftOrderId: draftOrder.id,
        purchaseOrderId: purchaseOrder.id,
      },
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Draft order creation failed.";
    const protectedCustomerDataBlocked = errorMessage.includes("protected customer data");

    await db.draftOrderSync.create({
      data: {
        shopId: input.shopId,
        purchaseOrderId: purchaseOrder.id,
        status: "FAILED",
        errorMessage,
      },
    });

    await createOpsCase({
      shopId: input.shopId,
      purchaseOrderId: purchaseOrder.id,
      summary: protectedCustomerDataBlocked
        ? "Draft-order creation is blocked until Shopify approves protected customer data access for this app."
        : "Draft-order creation failed after validation.",
    });

    await db.purchaseOrder.update({
      where: { id: purchaseOrder.id },
      data: {
        status: "OPS_REVIEW",
      },
    });
  }

  return db.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrder.id },
    include: {
      lineItems: true,
      validationIssues: true,
      draftOrderSync: true,
      opsCase: true,
    },
  });
}

export async function refreshSenderLearning(input: {
  shopId: string;
  senderProfileId?: string | null;
  purchaseOrderId: string;
}) {
  const purchaseOrder = await db.purchaseOrder.findUnique({
    where: { id: input.purchaseOrderId },
    include: {
      lineItems: true,
    },
  });

  if (!purchaseOrder) {
    return;
  }

  for (const lineItem of purchaseOrder.lineItems) {
    if (input.senderProfileId && lineItem.customerSku && lineItem.matchedVariantId) {
      await db.catalogAlias.upsert({
        where: {
          shopId_aliasType_normalizedValue_senderProfileId: {
            shopId: input.shopId,
            aliasType: "CUSTOMER_SKU",
            normalizedValue: normalizeValue(lineItem.customerSku),
            senderProfileId: input.senderProfileId,
          },
        },
        update: {
          variantId: lineItem.matchedVariantId,
          sku: lineItem.matchedSku,
          title: lineItem.matchedTitle,
        },
        create: {
          shopId: input.shopId,
          senderProfileId: input.senderProfileId,
          aliasType: "CUSTOMER_SKU",
          sourceValue: lineItem.customerSku,
          normalizedValue: normalizeValue(lineItem.customerSku),
          variantId: lineItem.matchedVariantId,
          sku: lineItem.matchedSku,
          title: lineItem.matchedTitle,
        },
      });
    }
  }

  if (purchaseOrder.contactEmail && purchaseOrder.matchedCustomerId) {
    await db.customerAlias.upsert({
      where: {
        shopId_aliasType_normalizedValue: {
          shopId: input.shopId,
          aliasType: "CONTACT_EMAIL",
          normalizedValue: normalizeValue(purchaseOrder.contactEmail),
        },
      },
      update: {
        customerId: purchaseOrder.matchedCustomerId,
        companyId: purchaseOrder.matchedCompanyId,
        companyLocationId: purchaseOrder.matchedCompanyLocationId,
        contactEmail: purchaseOrder.contactEmail,
      },
      create: {
        shopId: input.shopId,
        aliasType: "CONTACT_EMAIL",
        sourceValue: purchaseOrder.contactEmail,
        normalizedValue: normalizeValue(purchaseOrder.contactEmail),
        customerId: purchaseOrder.matchedCustomerId,
        companyId: purchaseOrder.matchedCompanyId,
        companyLocationId: purchaseOrder.matchedCompanyLocationId,
        contactEmail: purchaseOrder.contactEmail,
      },
    });
  }
}
