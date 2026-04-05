import { Prisma } from "@prisma/client";
import type {
  AuditActorType,
  CatalogAliasType,
  CustomerAliasType,
  PurchaseOrder,
  PurchaseOrderLine,
  SenderProfile,
} from "@prisma/client";
import db from "../db.server";
import {
  parseSpreadsheetHints,
  type SpreadsheetHintKey,
  type SpreadsheetHints,
} from "../lib/spreadsheet-hints";
import {
  normalizeValue,
} from "./extraction.server";
import type { ParsedSpreadsheetRow } from "./document-parser.server";
import { parseDocumentContent } from "./document-parser.server";
import { getStoredDocumentContentBase64 } from "./storage.server";
import {
  getVariantByLegacyId,
  searchCustomers,
  searchProductVariants,
  type VariantMatchCandidate,
} from "./shopify-admin.server";
import { createAuditEvent } from "./audit.server";

type PurchaseOrderWithMemory = PurchaseOrder & {
  lineItems: PurchaseOrderLine[];
  senderProfile: SenderProfile | null;
  sourceDocument: {
    id: string;
    kind: string;
    filename: string | null;
    contentType: string | null;
    storageProvider: string;
    storageKey: string | null;
    contentBase64: string | null;
  };
};

type LearningRefreshSummary = {
  savedCatalogAliasCount: number;
  savedCustomerAliasCount: number;
  updatedSpreadsheetHintKeys: SpreadsheetHintKey[];
};

type ComparableValue = string | null;

function asNullableString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeComparableValue(value: unknown): ComparableValue {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();

  if (!raw) {
    return null;
  }

  const compactNumeric = raw.replace(/,/g, "");
  const parsedNumeric = Number(compactNumeric);

  if (Number.isFinite(parsedNumeric) && /^-?\d+(?:\.\d+)?$/.test(compactNumeric)) {
    return String(parsedNumeric);
  }

  return normalizeValue(raw);
}

function addHintValue(existingValues: string[] | undefined, nextValue: string) {
  const deduped = new Set([...(existingValues ?? []), nextValue].filter(Boolean));
  return Array.from(deduped);
}

async function getPurchaseOrderForMemory(purchaseOrderId: string) {
  return db.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
      senderProfile: true,
      sourceDocument: true,
    },
  });
}

async function resolveVariantForManualLine(input: {
  shopDomain: string;
  lineItem: Pick<
    PurchaseOrderLine,
    "matchedVariantId" | "merchantSku" | "customerSku" | "description"
  >;
}) {
  if (input.lineItem.matchedVariantId) {
    const existing = await getVariantByLegacyId(input.shopDomain, input.lineItem.matchedVariantId);

    if (existing) {
      return existing;
    }
  }

  if (input.lineItem.merchantSku) {
    const variants = await searchProductVariants(input.shopDomain, input.lineItem.merchantSku);
    const normalizedSku = normalizeValue(input.lineItem.merchantSku);
    const exactSkuMatches = variants.filter(
      (variant) => variant.sku && normalizeValue(variant.sku) === normalizedSku,
    );

    if (exactSkuMatches.length === 1) {
      return exactSkuMatches[0]!;
    }

    if (variants.length === 1) {
      return variants[0]!;
    }
  }

  const fallbackTerms = [input.lineItem.customerSku, input.lineItem.description]
    .map(asNullableString)
    .filter((value): value is string => Boolean(value));

  for (const term of fallbackTerms) {
    const variants = await searchProductVariants(input.shopDomain, term);

    if (variants.length === 1) {
      return variants[0]!;
    }
  }

  return null;
}

async function resolveCustomerForMemory(input: {
  shopDomain: string;
  purchaseOrder: Pick<
    PurchaseOrderWithMemory,
    | "matchedCustomerId"
    | "matchedCompanyId"
    | "matchedCompanyLocationId"
    | "contactEmail"
    | "companyName"
    | "customerName"
    | "shipToName"
  >;
}) {
  if (
    input.purchaseOrder.matchedCustomerId ||
    input.purchaseOrder.matchedCompanyId ||
    input.purchaseOrder.matchedCompanyLocationId
  ) {
    return {
      customerId: input.purchaseOrder.matchedCustomerId,
      companyId: input.purchaseOrder.matchedCompanyId,
      companyLocationId: input.purchaseOrder.matchedCompanyLocationId,
    };
  }

  const searchTerms = [
    input.purchaseOrder.contactEmail,
    input.purchaseOrder.companyName,
    input.purchaseOrder.customerName,
    input.purchaseOrder.shipToName,
  ]
    .map(asNullableString)
    .filter((value): value is string => Boolean(value));

  for (const term of searchTerms) {
    const matches = await searchCustomers(input.shopDomain, term);

    if (matches.length === 1) {
      return {
        customerId: matches[0]!.legacyId,
        companyId: null,
        companyLocationId: null,
      };
    }
  }

  return {
    customerId: null,
    companyId: null,
    companyLocationId: null,
  };
}

function inferHeaderFromTargets(rows: ParsedSpreadsheetRow[], targetValues: unknown[]) {
  const comparableValues = targetValues
    .map((value) => normalizeComparableValue(value))
    .filter((value): value is string => Boolean(value));

  if (comparableValues.length === 0) {
    return null;
  }

  const targetSet = new Set(comparableValues);
  const scores = new Map<string, number>();

  for (const row of rows) {
    for (const [header, value] of Object.entries(row)) {
      const comparableCell = normalizeComparableValue(value);

      if (!header || !comparableCell || !targetSet.has(comparableCell)) {
        continue;
      }

      scores.set(header, (scores.get(header) ?? 0) + 1);
    }
  }

  const sorted = Array.from(scores.entries()).sort((left, right) => right[1] - left[1]);

  if (sorted.length === 0) {
    return null;
  }

  if (sorted.length > 1 && sorted[0]?.[1] === sorted[1]?.[1]) {
    return null;
  }

  return sorted[0]?.[0] ?? null;
}

async function inferSpreadsheetHintsForOrder(
  purchaseOrder: PurchaseOrderWithMemory,
): Promise<SpreadsheetHints> {
  if (!["CSV", "XLSX"].includes(purchaseOrder.sourceDocument.kind)) {
    return {};
  }

  const contentBase64 = await getStoredDocumentContentBase64({
    storageProvider: purchaseOrder.sourceDocument.storageProvider,
    storageKey: purchaseOrder.sourceDocument.storageKey,
    contentBase64: purchaseOrder.sourceDocument.contentBase64,
  });

  if (!contentBase64) {
    return {};
  }

  const parsed = await parseDocumentContent({
    kind: purchaseOrder.sourceDocument.kind as "CSV" | "XLSX",
    contentBase64,
    filename: purchaseOrder.sourceDocument.filename,
    contentType: purchaseOrder.sourceDocument.contentType,
  });

  if (parsed.structuredRows.length === 0) {
    return {};
  }

  const inferredHints: SpreadsheetHints = {};
  const singleValueHints: Array<[SpreadsheetHintKey, unknown]> = [
    ["poNumber", purchaseOrder.poNumber],
    ["customerName", purchaseOrder.customerName],
    ["companyName", purchaseOrder.companyName],
    ["contactEmail", purchaseOrder.contactEmail],
  ];
  const multiValueHints: Array<[SpreadsheetHintKey, unknown[]]> = [
    ["merchantSku", purchaseOrder.lineItems.map((lineItem) => lineItem.merchantSku)],
    ["customerSku", purchaseOrder.lineItems.map((lineItem) => lineItem.customerSku)],
    ["description", purchaseOrder.lineItems.map((lineItem) => lineItem.description)],
    ["quantity", purchaseOrder.lineItems.map((lineItem) => lineItem.quantity)],
    ["unitPrice", purchaseOrder.lineItems.map((lineItem) => lineItem.unitPrice?.toString())],
    ["uom", purchaseOrder.lineItems.map((lineItem) => lineItem.uom)],
  ];

  for (const [key, value] of singleValueHints) {
    const header = inferHeaderFromTargets(parsed.structuredRows, [value]);

    if (header) {
      inferredHints[key] = [header];
    }
  }

  for (const [key, values] of multiValueHints) {
    const header = inferHeaderFromTargets(parsed.structuredRows, values);

    if (header) {
      inferredHints[key] = [header];
    }
  }

  return inferredHints;
}

async function upsertCatalogAlias(input: {
  shopId: string;
  senderProfileId?: string | null;
  aliasType: CatalogAliasType;
  sourceValue: string;
  variant: VariantMatchCandidate;
}) {
  const existingAlias = await db.catalogAlias.findFirst({
    where: {
      shopId: input.shopId,
      senderProfileId: input.senderProfileId ?? null,
      aliasType: input.aliasType,
      normalizedValue: normalizeValue(input.sourceValue),
    },
    select: { id: true },
  });

  if (existingAlias) {
    await db.catalogAlias.update({
      where: { id: existingAlias.id },
      data: {
        sourceValue: input.sourceValue,
        variantId: input.variant.legacyId,
        sku: input.variant.sku,
        title: `${input.variant.productTitle} / ${input.variant.title}`,
      },
    });
    return;
  }

  await db.catalogAlias.create({
    data: {
      shopId: input.shopId,
      senderProfileId: input.senderProfileId ?? undefined,
      aliasType: input.aliasType,
      sourceValue: input.sourceValue,
      normalizedValue: normalizeValue(input.sourceValue),
      variantId: input.variant.legacyId,
      sku: input.variant.sku,
      title: `${input.variant.productTitle} / ${input.variant.title}`,
    },
  });
}

function buildCustomerAliasInputs(input: {
  purchaseOrder: PurchaseOrderWithMemory;
  senderEmail?: string | null;
  customerId?: string | null;
  companyId?: string | null;
  companyLocationId?: string | null;
}) {
  const candidateInputs: Array<{
    aliasType: CustomerAliasType;
    sourceValue: string | null | undefined;
  }> = [
    {
      aliasType: "CONTACT_EMAIL",
      sourceValue: input.purchaseOrder.contactEmail,
    },
    {
      aliasType: "COMPANY_NAME",
      sourceValue: input.purchaseOrder.companyName,
    },
    {
      aliasType: "SENDER_EMAIL",
      sourceValue: input.senderEmail,
    },
    {
      aliasType: "SHIP_TO_NAME",
      sourceValue: input.purchaseOrder.shipToName,
    },
  ];

  return candidateInputs
    .map((entry) => ({
      ...entry,
      sourceValue: asNullableString(entry.sourceValue),
    }))
    .filter(
      (entry): entry is {
        aliasType: CustomerAliasType;
        sourceValue: string;
      } => Boolean(entry.sourceValue) && Boolean(input.customerId || input.companyId || input.companyLocationId),
    )
    .map((entry) => ({
      ...entry,
      customerId: input.customerId ?? null,
      companyId: input.companyId ?? null,
      companyLocationId: input.companyLocationId ?? null,
      contactEmail: input.purchaseOrder.contactEmail ?? null,
    }));
}

export async function savePurchaseOrderCorrections(input: {
  purchaseOrderId: string;
  poNumber?: string | null;
  companyName?: string | null;
  customerName?: string | null;
  contactEmail?: string | null;
  currency?: string | null;
  notes?: string | null;
  lineItems: Array<{
    id: string;
    customerSku?: string | null;
    merchantSku?: string | null;
    description?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
    uom?: string | null;
  }>;
}) {
  await db.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: input.purchaseOrderId },
      data: {
        poNumber: asNullableString(input.poNumber),
        companyName: asNullableString(input.companyName),
        customerName: asNullableString(input.customerName),
        contactEmail: asNullableString(input.contactEmail),
        currency: asNullableString(input.currency),
        notes: asNullableString(input.notes),
      },
    });

    for (const lineItem of input.lineItems) {
      await tx.purchaseOrderLine.update({
        where: { id: lineItem.id },
        data: {
          customerSku: asNullableString(lineItem.customerSku),
          merchantSku: asNullableString(lineItem.merchantSku),
          description: asNullableString(lineItem.description),
          quantity: lineItem.quantity ?? null,
          unitPrice:
            lineItem.unitPrice === null || lineItem.unitPrice === undefined
              ? null
              : new Prisma.Decimal(lineItem.unitPrice),
          uom: asNullableString(lineItem.uom),
        },
      });
    }
  });
}

export async function refreshSenderLearning(input: {
  shopId: string;
  senderProfileId?: string | null;
  purchaseOrderId: string;
  shopDomain?: string;
}) {
  const purchaseOrder = await getPurchaseOrderForMemory(input.purchaseOrderId);

  if (!purchaseOrder) {
    return {
      savedCatalogAliasCount: 0,
      savedCustomerAliasCount: 0,
      updatedSpreadsheetHintKeys: [],
    } satisfies LearningRefreshSummary;
  }

  let savedCatalogAliasCount = 0;

  for (const lineItem of purchaseOrder.lineItems) {
    const existingVariant = input.shopDomain
      ? await resolveVariantForManualLine({
          shopDomain: input.shopDomain,
          lineItem,
        })
      : lineItem.matchedVariantId
        ? null
        : null;

    if (existingVariant && lineItem.matchedVariantId !== existingVariant.legacyId) {
      await db.purchaseOrderLine.update({
        where: { id: lineItem.id },
        data: {
          matchedVariantId: existingVariant.legacyId,
          matchedSku: existingVariant.sku,
          matchedTitle: `${existingVariant.productTitle} / ${existingVariant.title}`,
        },
      });
    }

    const resolvedVariant = existingVariant;

    if (!resolvedVariant || !input.senderProfileId) {
      continue;
    }

    if (lineItem.customerSku) {
      await upsertCatalogAlias({
        shopId: input.shopId,
        senderProfileId: input.senderProfileId,
        aliasType: "CUSTOMER_SKU",
        sourceValue: lineItem.customerSku,
        variant: resolvedVariant,
      });
      savedCatalogAliasCount += 1;
    }

    if (lineItem.description) {
      await upsertCatalogAlias({
        shopId: input.shopId,
        senderProfileId: input.senderProfileId,
        aliasType: "DESCRIPTION",
        sourceValue: lineItem.description,
        variant: resolvedVariant,
      });
      savedCatalogAliasCount += 1;
    }
  }

  let savedCustomerAliasCount = 0;
  const customerAliasInputs = buildCustomerAliasInputs({
    purchaseOrder,
    senderEmail: purchaseOrder.senderProfile?.senderEmail,
    customerId: purchaseOrder.matchedCustomerId,
    companyId: purchaseOrder.matchedCompanyId,
    companyLocationId: purchaseOrder.matchedCompanyLocationId,
  });

  for (const aliasInput of customerAliasInputs) {
    await db.customerAlias.upsert({
      where: {
        shopId_aliasType_normalizedValue: {
          shopId: input.shopId,
          aliasType: aliasInput.aliasType,
          normalizedValue: normalizeValue(aliasInput.sourceValue),
        },
      },
      update: {
        sourceValue: aliasInput.sourceValue,
        customerId: aliasInput.customerId,
        companyId: aliasInput.companyId,
        companyLocationId: aliasInput.companyLocationId,
        contactEmail: aliasInput.contactEmail,
      },
      create: {
        shopId: input.shopId,
        aliasType: aliasInput.aliasType,
        sourceValue: aliasInput.sourceValue,
        normalizedValue: normalizeValue(aliasInput.sourceValue),
        customerId: aliasInput.customerId,
        companyId: aliasInput.companyId,
        companyLocationId: aliasInput.companyLocationId,
        contactEmail: aliasInput.contactEmail,
      },
    });
    savedCustomerAliasCount += 1;
  }

  const updatedSpreadsheetHintKeys: SpreadsheetHintKey[] = [];

  if (purchaseOrder.senderProfile) {
    const inferredHints = await inferSpreadsheetHintsForOrder(purchaseOrder);
    const existingHints = parseSpreadsheetHints(purchaseOrder.senderProfile.spreadsheetHints);
    const mergedHints: SpreadsheetHints = { ...existingHints };

    for (const [key, values] of Object.entries(inferredHints) as Array<
      [SpreadsheetHintKey, string[] | undefined]
    >) {
      if (!values?.length) {
        continue;
      }

      updatedSpreadsheetHintKeys.push(key);
      mergedHints[key] = values.reduce(
        (accumulator, value) => addHintValue(accumulator, value),
        mergedHints[key],
      );
    }

    await db.senderProfile.update({
      where: { id: purchaseOrder.senderProfile.id },
      data: {
        customerName: purchaseOrder.customerName ?? undefined,
        companyName: purchaseOrder.companyName ?? undefined,
        contactEmail: purchaseOrder.contactEmail ?? undefined,
        defaultCurrency: purchaseOrder.currency ?? undefined,
        spreadsheetHints:
          Object.keys(mergedHints).length > 0
            ? (mergedHints as Prisma.InputJsonValue)
            : Prisma.JsonNull,
      },
    });
  }

  return {
    savedCatalogAliasCount,
    savedCustomerAliasCount,
    updatedSpreadsheetHintKeys,
  } satisfies LearningRefreshSummary;
}

export async function learnFromPurchaseOrderCorrections(input: {
  shopId: string;
  purchaseOrderId: string;
  shopDomain: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const purchaseOrder = await getPurchaseOrderForMemory(input.purchaseOrderId);

  if (!purchaseOrder) {
    return {
      savedCatalogAliasCount: 0,
      savedCustomerAliasCount: 0,
      updatedSpreadsheetHintKeys: [],
      updatedLineMatchCount: 0,
      updatedCustomerMatch: false,
    };
  }

  const customerMatch = await resolveCustomerForMemory({
    shopDomain: input.shopDomain,
    purchaseOrder,
  });
  let updatedCustomerMatch = false;

  if (
    customerMatch.customerId !== purchaseOrder.matchedCustomerId ||
    customerMatch.companyId !== purchaseOrder.matchedCompanyId ||
    customerMatch.companyLocationId !== purchaseOrder.matchedCompanyLocationId
  ) {
    await db.purchaseOrder.update({
      where: { id: purchaseOrder.id },
      data: {
        matchedCustomerId: customerMatch.customerId ?? undefined,
        matchedCompanyId: customerMatch.companyId ?? undefined,
        matchedCompanyLocationId: customerMatch.companyLocationId ?? undefined,
      },
    });
    updatedCustomerMatch = Boolean(customerMatch.customerId);
  }

  let updatedLineMatchCount = 0;

  for (const lineItem of purchaseOrder.lineItems) {
    const variant = await resolveVariantForManualLine({
      shopDomain: input.shopDomain,
      lineItem,
    });

    if (!variant) {
      continue;
    }

    await db.purchaseOrderLine.update({
      where: { id: lineItem.id },
      data: {
        matchedVariantId: variant.legacyId,
        matchedSku: variant.sku,
        matchedTitle: `${variant.productTitle} / ${variant.title}`,
        matchConfidence: 0.99,
      },
    });
    updatedLineMatchCount += 1;
  }

  const learningSummary = await refreshSenderLearning({
    shopId: input.shopId,
    senderProfileId: purchaseOrder.senderProfileId,
    purchaseOrderId: purchaseOrder.id,
    shopDomain: input.shopDomain,
  });

  await createAuditEvent({
    shopId: input.shopId,
    purchaseOrderId: purchaseOrder.id,
    entityType: "PURCHASE_ORDER",
    entityId: purchaseOrder.id,
    action: "CORRECTION_MEMORY_SAVED",
    summary: "Saved reviewed corrections into sender-specific mapping memory.",
    actorType: input.actorType ?? "SYSTEM",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      updatedCustomerMatch,
      updatedLineMatchCount,
      savedCatalogAliasCount: learningSummary.savedCatalogAliasCount,
      savedCustomerAliasCount: learningSummary.savedCustomerAliasCount,
      updatedSpreadsheetHintKeys: learningSummary.updatedSpreadsheetHintKeys,
    },
  });

  return {
    ...learningSummary,
    updatedLineMatchCount,
    updatedCustomerMatch,
  };
}

export async function saveSenderProfileMemory(input: {
  shopId: string;
  senderProfileId: string;
  companyName?: string | null;
  customerName?: string | null;
  contactEmail?: string | null;
  defaultCurrency?: string | null;
  sampleSubject?: string | null;
  spreadsheetHints: SpreadsheetHints;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const senderProfile = await db.senderProfile.findFirstOrThrow({
    where: {
      id: input.senderProfileId,
      shopId: input.shopId,
    },
  });

  const updatedSenderProfile = await db.senderProfile.update({
    where: {
      id: senderProfile.id,
    },
    data: {
      companyName: asNullableString(input.companyName),
      customerName: asNullableString(input.customerName),
      contactEmail: asNullableString(input.contactEmail),
      defaultCurrency: asNullableString(input.defaultCurrency),
      sampleSubject: asNullableString(input.sampleSubject),
      spreadsheetHints:
        Object.keys(input.spreadsheetHints).length > 0
          ? (input.spreadsheetHints as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
  });

  await createAuditEvent({
    shopId: input.shopId,
    entityType: "SHOP",
    entityId: updatedSenderProfile.id,
    action: "SENDER_MEMORY_UPDATED",
    summary: `Updated memory settings for ${updatedSenderProfile.senderEmail}.`,
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      senderProfileId: updatedSenderProfile.id,
      spreadsheetHintKeys: Object.keys(input.spreadsheetHints),
    },
  });

  return updatedSenderProfile;
}

export async function saveManualCatalogAlias(input: {
  shopId: string;
  shopDomain: string;
  senderProfileId: string;
  aliasType: CatalogAliasType;
  sourceValue: string;
  targetSku: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const normalizedTargetSku = asNullableString(input.targetSku);

  if (!normalizedTargetSku) {
    throw new Error("Enter the Shopify SKU to map this alias to.");
  }

  const variants = await searchProductVariants(input.shopDomain, normalizedTargetSku);
  const exactSkuMatches = variants.filter(
    (variant) => variant.sku && normalizeValue(variant.sku) === normalizeValue(normalizedTargetSku),
  );
  const variant =
    exactSkuMatches.length === 1
      ? exactSkuMatches[0]!
      : variants.length === 1
        ? variants[0]!
        : null;

  if (!variant) {
    throw new Error("Could not find exactly one Shopify variant for that SKU.");
  }

  await upsertCatalogAlias({
    shopId: input.shopId,
    senderProfileId: input.senderProfileId,
    aliasType: input.aliasType,
    sourceValue: input.sourceValue,
    variant,
  });

  await createAuditEvent({
    shopId: input.shopId,
    entityType: "SHOP",
    entityId: input.senderProfileId,
    action: "CATALOG_ALIAS_SAVED",
    summary: `Saved ${input.aliasType.toLowerCase()} alias "${input.sourceValue}" to ${variant.sku ?? variant.legacyId}.`,
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      senderProfileId: input.senderProfileId,
      aliasType: input.aliasType,
      sourceValue: input.sourceValue,
      variantId: variant.legacyId,
      sku: variant.sku,
    },
  });
}

export async function deleteCatalogAlias(input: {
  shopId: string;
  aliasId: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const alias = await db.catalogAlias.findFirstOrThrow({
    where: {
      id: input.aliasId,
      shopId: input.shopId,
    },
  });

  await db.catalogAlias.delete({
    where: { id: alias.id },
  });

  await createAuditEvent({
    shopId: input.shopId,
    entityType: "SHOP",
    entityId: alias.id,
    action: "CATALOG_ALIAS_DELETED",
    summary: `Deleted ${alias.aliasType.toLowerCase()} alias "${alias.sourceValue}".`,
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      aliasId: alias.id,
      senderProfileId: alias.senderProfileId,
      aliasType: alias.aliasType,
      sourceValue: alias.sourceValue,
      variantId: alias.variantId,
    },
  });
}

export async function deleteCustomerAlias(input: {
  shopId: string;
  aliasId: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const alias = await db.customerAlias.findFirstOrThrow({
    where: {
      id: input.aliasId,
      shopId: input.shopId,
    },
  });

  await db.customerAlias.delete({
    where: { id: alias.id },
  });

  await createAuditEvent({
    shopId: input.shopId,
    entityType: "SHOP",
    entityId: alias.id,
    action: "CUSTOMER_ALIAS_DELETED",
    summary: `Deleted ${alias.aliasType.toLowerCase()} customer alias "${alias.sourceValue}".`,
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      aliasId: alias.id,
      aliasType: alias.aliasType,
      sourceValue: alias.sourceValue,
      customerId: alias.customerId,
    },
  });
}

export async function saveManualCustomerAlias(input: {
  shopId: string;
  shopDomain: string;
  aliasType: CustomerAliasType;
  sourceValue: string;
  targetLookup: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
}) {
  const normalizedSourceValue = asNullableString(input.sourceValue);
  const normalizedTargetLookup = asNullableString(input.targetLookup);

  if (!normalizedSourceValue) {
    throw new Error("Enter the sender or customer value you want DraftBridge to remember.");
  }

  if (!normalizedTargetLookup) {
    throw new Error("Enter a customer lookup value so DraftBridge can find the Shopify customer.");
  }

  const matches = await searchCustomers(input.shopDomain, normalizedTargetLookup);

  if (matches.length !== 1) {
    throw new Error("Customer lookup must return exactly one Shopify customer.");
  }

  const customer = matches[0]!;
  const existingAlias = await db.customerAlias.findFirst({
    where: {
      shopId: input.shopId,
      aliasType: input.aliasType,
      normalizedValue: normalizeValue(normalizedSourceValue),
    },
    select: { id: true },
  });

  if (existingAlias) {
    await db.customerAlias.update({
      where: { id: existingAlias.id },
      data: {
        sourceValue: normalizedSourceValue,
        customerId: customer.legacyId,
      },
    });
  } else {
    await db.customerAlias.create({
      data: {
        shopId: input.shopId,
        aliasType: input.aliasType,
        sourceValue: normalizedSourceValue,
        normalizedValue: normalizeValue(normalizedSourceValue),
        customerId: customer.legacyId,
      },
    });
  }

  await createAuditEvent({
    shopId: input.shopId,
    entityType: "SHOP",
    entityId: customer.legacyId,
    action: "CUSTOMER_ALIAS_SAVED",
    summary: `Saved ${input.aliasType.toLowerCase()} alias "${normalizedSourceValue}" to customer ${customer.legacyId}.`,
    actorType: input.actorType ?? "USER",
    actorUserId: input.actorUserId ?? undefined,
    metadata: {
      aliasType: input.aliasType,
      sourceValue: normalizedSourceValue,
      customerId: customer.legacyId,
      targetLookup: normalizedTargetLookup,
    },
  });
}
