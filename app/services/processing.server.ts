import OpenAI from "openai";
import type {
  AuditActorType,
  SenderProfile,
  SourceDocument,
  ValidationSeverity,
} from "@prisma/client";
import db from "../db.server";
import { hasOpenAiConfig } from "../lib/env.server";
import { createAuditEvent } from "./audit.server";
import { recordOverageUsageCharge } from "./billing.server";
import type { ParsedSpreadsheetRow } from "./document-parser.server";
import {
  extractedPoSchema,
  extractSpreadsheetPurchaseOrder,
  extractTextPurchaseOrder,
  normalizeValue,
  type ExtractedPurchaseOrder,
} from "./extraction.server";
import { refreshSenderLearning } from "./memory.server";
import { advanceOnboardingStatus } from "./shop.server";
import {
  createDraftOrder,
  getVariantByLegacyId,
  searchCustomers,
  searchProductVariants,
} from "./shopify-admin.server";

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

async function getUsageEventType(shopId: string) {
  const billingState = await db.billingState.findUnique({
    where: { shopId },
    select: {
      includedUsageLimit: true,
      currentPeriodStart: true,
    },
  });

  const usageCount = await db.usageLedger.count({
    where: {
      shopId,
      billable: true,
      ...(billingState?.currentPeriodStart
        ? {
            occurredAt: {
              gte: billingState.currentPeriodStart,
            },
          }
        : {}),
    },
  });

  return usageCount < (billingState?.includedUsageLimit ?? 0)
    ? "INCLUDED_SUCCESS"
    : "OVERAGE_SUCCESS";
}

async function extractWithOpenAi(input: {
  text: string;
  model: string;
}) {
  if (!hasOpenAiConfig() || !input.text.trim()) {
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

function mergePurchaseOrderCandidates(
  primaryCandidate: ExtractedPurchaseOrder,
  supplementalCandidate: ExtractedPurchaseOrder | null,
) {
  if (!supplementalCandidate) {
    return primaryCandidate;
  }

  const mergedNotes = [primaryCandidate.notes, supplementalCandidate.notes]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n")
    .slice(0, 1000) || null;

  return extractedPoSchema.parse({
    poNumber: primaryCandidate.poNumber ?? supplementalCandidate.poNumber ?? null,
    customerName: primaryCandidate.customerName ?? supplementalCandidate.customerName ?? null,
    companyName: primaryCandidate.companyName ?? supplementalCandidate.companyName ?? null,
    contactEmail: primaryCandidate.contactEmail ?? supplementalCandidate.contactEmail ?? null,
    currency: primaryCandidate.currency ?? supplementalCandidate.currency ?? null,
    orderDate: primaryCandidate.orderDate ?? supplementalCandidate.orderDate ?? null,
    shipToName: primaryCandidate.shipToName ?? supplementalCandidate.shipToName ?? null,
    shipToAddress: primaryCandidate.shipToAddress ?? supplementalCandidate.shipToAddress ?? null,
    billToName: primaryCandidate.billToName ?? supplementalCandidate.billToName ?? null,
    billToAddress: primaryCandidate.billToAddress ?? supplementalCandidate.billToAddress ?? null,
    notes: mergedNotes,
    confidence: Math.max(primaryCandidate.confidence ?? 0, supplementalCandidate.confidence ?? 0),
    lineItems:
      primaryCandidate.lineItems.length > 0
        ? primaryCandidate.lineItems
        : supplementalCandidate.lineItems,
  });
}

async function extractCandidatePurchaseOrder(input: {
  sourceDocument: SourceDocument;
  senderProfile: SenderProfile | null;
  structuredRows: ParsedSpreadsheetRow[];
  supplementalText?: string | null;
}) {
  const extractedText = input.sourceDocument.extractedText?.trim() || "";
  const primaryText = [extractedText, input.supplementalText?.trim() || ""]
    .filter(Boolean)
    .join("\n\n");

  let candidate =
    input.structuredRows.length > 0
      ? extractSpreadsheetPurchaseOrder(input.structuredRows, input.senderProfile)
      : extractTextPurchaseOrder(primaryText, input.senderProfile);

  if (input.supplementalText && input.sourceDocument.kind !== "EMAIL_BODY") {
    candidate = mergePurchaseOrderCandidates(
      candidate,
      extractTextPurchaseOrder(input.supplementalText, input.senderProfile),
    );
  }

  if (
    candidate.lineItems.length === 0 ||
    (candidate.confidence ?? 0) < RETRY_THRESHOLD
  ) {
    const openAiCandidate = await extractWithOpenAi({
      text: primaryText,
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.4-mini",
    });

    if (openAiCandidate) {
      candidate =
        openAiCandidate.lineItems.length > candidate.lineItems.length
          ? mergePurchaseOrderCandidates(openAiCandidate, candidate)
          : mergePurchaseOrderCandidates(candidate, openAiCandidate);
    }
  }

  return candidate;
}

async function findCustomerMatch(input: {
  shopId: string;
  shopDomain: string;
  contactEmail?: string | null;
  companyName?: string | null;
  customerName?: string | null;
  matchedCustomerId?: string | null;
  matchedCompanyId?: string | null;
  matchedCompanyLocationId?: string | null;
}) {
  if (input.matchedCustomerId || input.matchedCompanyId || input.matchedCompanyLocationId) {
    return {
      customerId: input.matchedCustomerId ?? null,
      companyId: input.matchedCompanyId ?? null,
      companyLocationId: input.matchedCompanyLocationId ?? null,
      confidence: input.matchedCustomerId ? 0.99 : 0.94,
    };
  }

  const aliases = await db.customerAlias.findMany({
    where: {
      shopId: input.shopId,
      normalizedValue: {
        in: [
          normalizeValue(input.contactEmail),
          normalizeValue(input.companyName),
          normalizeValue(input.customerName),
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

  const searchTerm = input.contactEmail || input.companyName || input.customerName || "";
  const customers = await searchCustomers(input.shopDomain, searchTerm);

  if (customers.length === 1) {
    return {
      customerId: customers[0].legacyId,
      companyId: null,
      companyLocationId: alias?.companyLocationId ?? null,
      confidence: input.contactEmail ? 0.93 : 0.84,
    };
  }

  if (input.contactEmail) {
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
    matchedVariantId?: string | null;
  };
}) {
  if (input.lineItem.matchedVariantId) {
    const existingMatch = await getVariantByLegacyId(input.shopDomain, input.lineItem.matchedVariantId);

    if (existingMatch) {
      return {
        variantId: existingMatch.legacyId,
        matchedSku: existingMatch.sku,
        matchedTitle: `${existingMatch.productTitle} / ${existingMatch.title}`,
        price: existingMatch.price,
        confidence: 0.99,
      };
    }
  }

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

  const alias = aliasFilters.length
    ? await db.catalogAlias.findFirst({
        where: {
          shopId: input.shopId,
          senderProfileId: input.senderProfileId ?? null,
          OR: aliasFilters,
        },
      })
    : null;

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

async function upsertOpsCase(input: {
  shopId: string;
  purchaseOrderId: string;
  summary: string;
  status?: "OPEN" | "IN_PROGRESS" | "WAITING_ON_MERCHANT" | "RESOLVED";
  resolutionNotes?: string | null;
}) {
  const opsCase = await db.opsCase.upsert({
    where: { purchaseOrderId: input.purchaseOrderId },
    update: {
      status: input.status ?? "OPEN",
      summary: input.summary,
      resolutionNotes: input.resolutionNotes ?? undefined,
      clarificationRequestedAt:
        input.status === "WAITING_ON_MERCHANT" ? new Date() : undefined,
      resolvedAt: input.status === "RESOLVED" ? new Date() : null,
    },
    create: {
      shopId: input.shopId,
      purchaseOrderId: input.purchaseOrderId,
      summary: input.summary,
      status: input.status ?? "OPEN",
      resolutionNotes: input.resolutionNotes ?? undefined,
      clarificationRequestedAt:
        input.status === "WAITING_ON_MERCHANT" ? new Date() : undefined,
      resolvedAt: input.status === "RESOLVED" ? new Date() : undefined,
    },
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: input.purchaseOrderId,
    opsCaseId: opsCase.id,
    entityType: "OPS_CASE",
    entityId: opsCase.id,
    action:
      input.status === "RESOLVED"
        ? "OPS_CASE_RESOLVED"
        : input.status === "WAITING_ON_MERCHANT"
          ? "OPS_CASE_WAITING_ON_MERCHANT"
          : "OPS_CASE_OPENED",
    summary: input.summary,
    metadata: {
      status: opsCase.status,
    },
  });

  return opsCase;
}

async function resolveOpsCase(input: {
  shopId: string;
  purchaseOrderId: string;
  summary: string;
}) {
  const existingOpsCase = await db.opsCase.findUnique({
    where: { purchaseOrderId: input.purchaseOrderId },
  });

  if (!existingOpsCase) {
    return null;
  }

  return upsertOpsCase({
    shopId: input.shopId,
    purchaseOrderId: input.purchaseOrderId,
    summary: input.summary,
    status: "RESOLVED",
  });
}

async function syncValidationIssues(input: {
  shopId: string;
  purchaseOrderId: string;
  issues: Array<{
    lineItemId?: string;
    severity: ValidationSeverity;
    code: string;
    message: string;
    blocking: boolean;
  }>;
}) {
  await db.validationIssue.deleteMany({
    where: { purchaseOrderId: input.purchaseOrderId },
  });

  if (input.issues.length === 0) {
    return;
  }

  await db.validationIssue.createMany({
    data: input.issues.map((issue) => ({
      shopId: input.shopId,
      purchaseOrderId: input.purchaseOrderId,
      lineItemId: issue.lineItemId,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      blocking: issue.blocking,
    })),
  });
}

async function recordUsageSuccess(input: {
  shopId: string;
  shopDomain: string;
  purchaseOrderId: string;
  poNumber?: string | null;
}) {
  const existingLedger = await db.usageLedger.findFirst({
    where: {
      purchaseOrderId: input.purchaseOrderId,
      billable: true,
    },
  });

  if (existingLedger) {
    return existingLedger;
  }

  const eventType = await getUsageEventType(input.shopId);
  const usageLedger = await db.usageLedger.create({
    data: {
      shopId: input.shopId,
      purchaseOrderId: input.purchaseOrderId,
      eventType,
    },
  });

  if (eventType === "OVERAGE_SUCCESS") {
    const billingState = await db.billingState.findUnique({
      where: { shopId: input.shopId },
      select: { plan: true },
    });

    if (billingState?.plan && billingState.plan !== "FREE") {
      try {
        await recordOverageUsageCharge({
          shopDomain: input.shopDomain,
          billingPlan: billingState.plan,
          usageLedgerId: usageLedger.id,
          description: `DraftBridge overage for successful PO ${input.poNumber || input.purchaseOrderId}`,
        });

        await db.usageLedger.update({
          where: { id: usageLedger.id },
          data: { billedAt: new Date() },
        });
      } catch (error) {
        console.error("Failed to record Shopify overage charge", {
          shopDomain: input.shopDomain,
          purchaseOrderId: input.purchaseOrderId,
          usageLedgerId: usageLedger.id,
          error,
        });
      }
    }
  }

  return usageLedger;
}

function buildOpsSummary(input: {
  hasBlockingIssues: boolean;
  finalConfidence: number;
}) {
  if (input.hasBlockingIssues) {
    return "Purchase order contains blocking validation issues.";
  }

  if (input.finalConfidence < AUTO_CREATE_THRESHOLD) {
    return "Purchase order needs manual review before draft-order creation.";
  }

  return "Purchase order requires manual review.";
}

async function seedPurchaseOrderFromCandidate(input: {
  existingPurchaseOrderId?: string;
  shopId: string;
  inboundMessageId: string;
  sourceDocumentId: string;
  mailboxId: string;
  senderProfileId?: string | null;
  candidate: ExtractedPurchaseOrder;
}) {
  const parsedOrderDate = parseDateValue(input.candidate.orderDate);

  if (input.existingPurchaseOrderId) {
    await db.validationIssue.deleteMany({
      where: { purchaseOrderId: input.existingPurchaseOrderId },
    });
    await db.purchaseOrderLine.deleteMany({
      where: { purchaseOrderId: input.existingPurchaseOrderId },
    });
    await db.draftOrderSync.deleteMany({
      where: { purchaseOrderId: input.existingPurchaseOrderId },
    });

    return db.purchaseOrder.update({
      where: { id: input.existingPurchaseOrderId },
      data: {
        inboundMessageId: input.inboundMessageId,
        sourceDocumentId: input.sourceDocumentId,
        mailboxId: input.mailboxId,
        senderProfileId: input.senderProfileId ?? undefined,
        poNumber: input.candidate.poNumber ?? undefined,
        customerName: input.candidate.customerName ?? undefined,
        companyName: input.candidate.companyName ?? undefined,
        contactEmail: input.candidate.contactEmail ?? undefined,
        currency: input.candidate.currency ?? undefined,
        orderDate: parsedOrderDate ?? undefined,
        shipToName: input.candidate.shipToName ?? undefined,
        shipToAddress: input.candidate.shipToAddress ?? undefined,
        billToName: input.candidate.billToName ?? undefined,
        billToAddress: input.candidate.billToAddress ?? undefined,
        notes: input.candidate.notes ?? undefined,
        extractedConfidence: input.candidate.confidence ?? 0,
        finalConfidence: 0,
        clarificationNeeded: false,
        duplicateOfId: null,
        matchedCustomerId: null,
        matchedCompanyId: null,
        matchedCompanyLocationId: null,
        billableSuccessAt: null,
        lastRetriedAt: new Date(),
        status: "EXTRACTED",
        lineItems: {
          create: input.candidate.lineItems.map((lineItem, index) => ({
            lineNumber: index + 1,
            customerSku: lineItem.customerSku ?? undefined,
            merchantSku: lineItem.merchantSku ?? undefined,
            description: lineItem.description ?? undefined,
            quantity: lineItem.quantity ?? undefined,
            unitPrice: lineItem.unitPrice ?? undefined,
            uom: lineItem.uom ?? undefined,
            extractedConfidence: lineItem.confidence ?? input.candidate.confidence ?? 0,
          })),
        },
      },
      include: {
        lineItems: true,
        opsCase: true,
      },
    });
  }

  return db.purchaseOrder.create({
    data: {
      shopId: input.shopId,
      inboundMessageId: input.inboundMessageId,
      sourceDocumentId: input.sourceDocumentId,
      mailboxId: input.mailboxId,
      senderProfileId: input.senderProfileId ?? undefined,
      poNumber: input.candidate.poNumber ?? undefined,
      customerName: input.candidate.customerName ?? undefined,
      companyName: input.candidate.companyName ?? undefined,
      contactEmail: input.candidate.contactEmail ?? undefined,
      currency: input.candidate.currency ?? undefined,
      orderDate: parsedOrderDate ?? undefined,
      shipToName: input.candidate.shipToName ?? undefined,
      shipToAddress: input.candidate.shipToAddress ?? undefined,
      billToName: input.candidate.billToName ?? undefined,
      billToAddress: input.candidate.billToAddress ?? undefined,
      notes: input.candidate.notes ?? undefined,
      extractedConfidence: input.candidate.confidence ?? 0,
      status: "EXTRACTED",
      lineItems: {
        create: input.candidate.lineItems.map((lineItem, index) => ({
          lineNumber: index + 1,
          customerSku: lineItem.customerSku ?? undefined,
          merchantSku: lineItem.merchantSku ?? undefined,
          description: lineItem.description ?? undefined,
          quantity: lineItem.quantity ?? undefined,
          unitPrice: lineItem.unitPrice ?? undefined,
          uom: lineItem.uom ?? undefined,
          extractedConfidence: lineItem.confidence ?? input.candidate.confidence ?? 0,
        })),
      },
    },
    include: {
      lineItems: true,
      opsCase: true,
    },
  });
}

export async function retryPurchaseOrderResolution(input: {
  purchaseOrderId: string;
  shopDomain: string;
}) {
  const purchaseOrder = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: input.purchaseOrderId },
    include: {
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
      senderProfile: true,
      draftOrderSync: true,
      opsCase: true,
    },
  });

  const duplicate =
    purchaseOrder.poNumber
      ? await db.purchaseOrder.findFirst({
          where: {
            shopId: purchaseOrder.shopId,
            poNumber: purchaseOrder.poNumber,
            id: {
              not: purchaseOrder.id,
            },
          },
          select: { id: true },
        })
      : null;

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
      message: `PO ${purchaseOrder.poNumber} already exists for this shop.`,
      blocking: true,
    });
  }

  const customerMatch = await findCustomerMatch({
    shopId: purchaseOrder.shopId,
    shopDomain: input.shopDomain,
    contactEmail: purchaseOrder.contactEmail,
    companyName: purchaseOrder.companyName,
    customerName: purchaseOrder.customerName,
    matchedCustomerId: purchaseOrder.matchedCustomerId,
    matchedCompanyId: purchaseOrder.matchedCompanyId,
    matchedCompanyLocationId: purchaseOrder.matchedCompanyLocationId,
  });

  if (!customerMatch.customerId) {
    validationIssues.push({
      severity: "WARNING",
      code: "CUSTOMER_NOT_CONFIRMED",
      message: "Could not confidently match a Shopify customer for this sender.",
      blocking: false,
    });
  }

  const lineConfidence: number[] = [];
  const matchedLines: Array<{
    variantLegacyId: string;
    quantity: number;
    originalUnitPrice: string | null;
  }> = [];

  for (const lineItem of purchaseOrder.lineItems) {
    const match = await findVariantMatch({
      shopId: purchaseOrder.shopId,
      shopDomain: input.shopDomain,
      senderProfileId: purchaseOrder.senderProfileId,
      lineItem,
    });
    const quantity = lineItem.quantity ?? 0;
    const unitPrice = lineItem.unitPrice ? Number(lineItem.unitPrice) : null;

    let validationStatus: "MATCHED" | "REVIEW_REQUIRED" | "INVALID" = "MATCHED";
    const lineIssues: Array<{
      severity: ValidationSeverity;
      code: string;
      message: string;
      blocking: boolean;
    }> = [];

    if (!quantity || quantity < 1) {
      lineIssues.push({
        severity: "ERROR",
        code: "INVALID_QUANTITY",
        message: `Line ${lineItem.lineNumber} has an invalid quantity.`,
        blocking: true,
      });
      validationStatus = "INVALID";
    }

    if (!match.variantId) {
      lineIssues.push({
        severity: "ERROR",
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
        severity: "ERROR",
        code: "PRICE_MISMATCH",
        message: `Line ${lineItem.lineNumber} price ${unitPrice.toFixed(2)} does not match Shopify price ${match.price.toFixed(2)} within tolerance.`,
        blocking: true,
      });
      validationStatus = "REVIEW_REQUIRED";
    }

    if (unitPrice === null && match.price !== null) {
      lineIssues.push({
        severity: "WARNING",
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

    if (match.variantId) {
      matchedLines.push({
        variantLegacyId: match.variantId,
        quantity,
        originalUnitPrice:
          unitPrice !== null ? unitPrice.toFixed(2) : match.price?.toFixed(2) ?? null,
      });
    }
  }

  if (purchaseOrder.lineItems.length === 0) {
    validationIssues.push({
      severity: "ERROR",
      code: "NO_LINE_ITEMS",
      message: "No order lines could be extracted from this document.",
      blocking: true,
    });
  }

  if (purchaseOrder.extractedConfidence !== null && purchaseOrder.extractedConfidence !== undefined) {
    lineConfidence.push(purchaseOrder.extractedConfidence);
  }

  const finalConfidence = averageConfidence([
    customerMatch.confidence,
    ...lineConfidence,
  ]);
  const hasBlockingIssues = validationIssues.some((issue) => issue.blocking);

  await syncValidationIssues({
    shopId: purchaseOrder.shopId,
    purchaseOrderId: purchaseOrder.id,
    issues: validationIssues,
  });

  const nextStatus =
    hasBlockingIssues || finalConfidence < AUTO_CREATE_THRESHOLD
      ? duplicate
        ? "DUPLICATE"
        : "OPS_REVIEW"
      : "VALIDATED";

  await db.purchaseOrder.update({
    where: { id: purchaseOrder.id },
    data: {
      status: nextStatus,
      finalConfidence,
      duplicateOfId: duplicate?.id ?? null,
      matchedCustomerId: customerMatch.customerId ?? undefined,
      matchedCompanyId: customerMatch.companyId ?? undefined,
      matchedCompanyLocationId: customerMatch.companyLocationId ?? undefined,
      clarificationNeeded: hasBlockingIssues || !customerMatch.customerId,
    },
  });

  if (hasBlockingIssues || finalConfidence < AUTO_CREATE_THRESHOLD) {
    await upsertOpsCase({
      shopId: purchaseOrder.shopId,
      purchaseOrderId: purchaseOrder.id,
      summary: buildOpsSummary({
        hasBlockingIssues,
        finalConfidence,
      }),
    });

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

  try {
    const existingDraftOrder = await db.draftOrderSync.findUnique({
      where: { purchaseOrderId: purchaseOrder.id },
    });

    let draftOrderId = existingDraftOrder?.shopifyDraftOrderId ?? null;
    let draftOrderName = existingDraftOrder?.shopifyDraftOrderName ?? null;

    if (!draftOrderId) {
      const draftOrder = await createDraftOrder({
        shopDomain: input.shopDomain,
        customerLegacyId: customerMatch.customerId,
        companyLegacyId: customerMatch.companyId,
        companyLocationLegacyId: customerMatch.companyLocationId,
        contactEmail: purchaseOrder.contactEmail,
        poNumber: purchaseOrder.poNumber,
        note: purchaseOrder.notes,
        currencyCode: purchaseOrder.currency,
        lineItems: matchedLines,
      });

      draftOrderId = String(draftOrder.id);
      draftOrderName = draftOrder.name;

      await db.draftOrderSync.upsert({
        where: { purchaseOrderId: purchaseOrder.id },
        update: {
          status: "CREATED",
          shopifyDraftOrderId: draftOrderId,
          shopifyDraftOrderName: draftOrderName,
          errorMessage: null,
        },
        create: {
          shopId: purchaseOrder.shopId,
          purchaseOrderId: purchaseOrder.id,
          status: "CREATED",
          shopifyDraftOrderId: draftOrderId,
          shopifyDraftOrderName: draftOrderName,
        },
      });

      await createAuditEvent({
        shopId: purchaseOrder.shopId,
        purchaseOrderId: purchaseOrder.id,
        entityType: "DRAFT_ORDER",
        entityId: draftOrderId,
        action: "DRAFT_ORDER_CREATED",
        summary: `Created Shopify draft order ${draftOrderName}.`,
        metadata: {
          shopifyDraftOrderId: draftOrderId,
          purchaseOrderId: purchaseOrder.id,
        },
      });
    }

    await recordUsageSuccess({
      shopId: purchaseOrder.shopId,
      shopDomain: input.shopDomain,
      purchaseOrderId: purchaseOrder.id,
      poNumber: purchaseOrder.poNumber,
    });

    await db.purchaseOrder.update({
      where: { id: purchaseOrder.id },
      data: {
        status: "AUTO_DRAFTED",
        billableSuccessAt: purchaseOrder.billableSuccessAt ?? new Date(),
      },
    });

    await refreshSenderLearning({
      shopId: purchaseOrder.shopId,
      senderProfileId: purchaseOrder.senderProfileId,
      purchaseOrderId: purchaseOrder.id,
      shopDomain: input.shopDomain,
    });
    await advanceOnboardingStatus(purchaseOrder.shopId, "READY");
    await resolveOpsCase({
      shopId: purchaseOrder.shopId,
      purchaseOrderId: purchaseOrder.id,
      summary: `Draft order ${draftOrderName ?? draftOrderId ?? ""} created successfully.`,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Draft order creation failed.";
    const protectedCustomerDataBlocked = errorMessage.includes("protected customer data");

    await db.draftOrderSync.upsert({
      where: { purchaseOrderId: purchaseOrder.id },
      update: {
        status: "FAILED",
        errorMessage,
      },
      create: {
        shopId: purchaseOrder.shopId,
        purchaseOrderId: purchaseOrder.id,
        status: "FAILED",
        errorMessage,
      },
    });

    await upsertOpsCase({
      shopId: purchaseOrder.shopId,
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

export async function processSourceDocument(input: {
  shopId: string;
  shopDomain: string;
  inboundMessageId: string;
  mailboxId: string;
  senderProfile: SenderProfile | null;
  sourceDocument: SourceDocument;
  structuredRows: ParsedSpreadsheetRow[];
  supplementalText?: string | null;
  existingPurchaseOrderId?: string;
}) {
  const candidate = await extractCandidatePurchaseOrder({
    sourceDocument: input.sourceDocument,
    senderProfile: input.senderProfile,
    structuredRows: input.structuredRows,
    supplementalText: input.supplementalText,
  });

  const purchaseOrder = await seedPurchaseOrderFromCandidate({
    existingPurchaseOrderId: input.existingPurchaseOrderId,
    shopId: input.shopId,
    inboundMessageId: input.inboundMessageId,
    sourceDocumentId: input.sourceDocument.id,
    mailboxId: input.mailboxId,
    senderProfileId: input.senderProfile?.id,
    candidate,
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: purchaseOrder.id,
    entityType: "PURCHASE_ORDER",
    entityId: purchaseOrder.id,
    action: input.existingPurchaseOrderId ? "PURCHASE_ORDER_REEXTRACTED" : "PURCHASE_ORDER_EXTRACTED",
    summary: `Extracted a candidate purchase order from ${input.sourceDocument.filename ?? input.sourceDocument.kind.toLowerCase()}.`,
  });

  return retryPurchaseOrderResolution({
    purchaseOrderId: purchaseOrder.id,
    shopDomain: input.shopDomain,
  });
}

export async function requestMerchantClarification(input: {
  shopId: string;
  purchaseOrderId: string;
  summary: string;
}) {
  return upsertOpsCase({
    shopId: input.shopId,
    purchaseOrderId: input.purchaseOrderId,
    summary: input.summary,
    status: "WAITING_ON_MERCHANT",
  });
}

export async function submitMerchantClarification(input: {
  shopId: string;
  purchaseOrderId: string;
  note: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const purchaseOrder = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: input.purchaseOrderId },
    include: { opsCase: true },
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: input.purchaseOrderId,
    opsCaseId: purchaseOrder.opsCase?.id ?? null,
    entityType: "PURCHASE_ORDER",
    entityId: input.purchaseOrderId,
    action: "MERCHANT_CLARIFICATION_SUBMITTED",
    summary: "Merchant submitted clarification notes for this purchase order.",
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      note: input.note,
    },
  });

  if (purchaseOrder.opsCase) {
    await db.opsCase.update({
      where: { id: purchaseOrder.opsCase.id },
      data: {
        status: "IN_PROGRESS",
        resolutionNotes: input.note,
      },
    });
  } else {
    await upsertOpsCase({
      shopId: input.shopId,
      purchaseOrderId: input.purchaseOrderId,
      summary: "Merchant submitted clarification notes.",
      status: "IN_PROGRESS",
      resolutionNotes: input.note,
    });
  }
}
