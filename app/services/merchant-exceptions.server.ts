import type { OpsCaseStatus, Prisma, PurchaseOrderStatus } from "@prisma/client";
import db from "../db.server";

export const MERCHANT_EXCEPTION_ORDER_STATUSES = [
  "OPS_REVIEW",
  "DUPLICATE",
] as const satisfies readonly PurchaseOrderStatus[];

export const MERCHANT_EXCEPTION_OPS_CASE_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_ON_MERCHANT",
] as const satisfies readonly OpsCaseStatus[];

type MerchantExceptionSummaryInput = Array<{
  status: PurchaseOrderStatus;
  clarificationNeeded: boolean;
  validationIssues: Array<{ blocking: boolean }>;
  opsCase: { status: OpsCaseStatus } | null;
}>;

export function buildMerchantExceptionWhere(
  shopId: string,
): Prisma.PurchaseOrderWhereInput {
  return {
    shopId,
    OR: [
      {
        status: {
          in: [...MERCHANT_EXCEPTION_ORDER_STATUSES],
        },
      },
      {
        clarificationNeeded: true,
      },
      {
        opsCase: {
          is: {
            status: {
              in: [...MERCHANT_EXCEPTION_OPS_CASE_STATUSES],
            },
          },
        },
      },
    ],
  };
}

export function summarizeMerchantExceptions(
  orders: MerchantExceptionSummaryInput,
) {
  const waitingOnMerchantCount = orders.filter(
    (order) =>
      order.clarificationNeeded || order.opsCase?.status === "WAITING_ON_MERCHANT",
  ).length;
  const duplicateCount = orders.filter(
    (order) => order.status === "DUPLICATE",
  ).length;
  const blockingIssueCount = orders.filter((order) =>
    order.validationIssues.some((issue) => issue.blocking),
  ).length;

  return {
    totalCount: orders.length,
    waitingOnMerchantCount,
    underReviewCount: Math.max(orders.length - waitingOnMerchantCount, 0),
    duplicateCount,
    blockingIssueCount,
  };
}

export function describeMerchantExceptionState(input: {
  status: PurchaseOrderStatus;
  clarificationNeeded: boolean;
  opsCaseStatus?: OpsCaseStatus | null;
  blockingIssueCount?: number;
}) {
  if (
    input.clarificationNeeded ||
    input.opsCaseStatus === "WAITING_ON_MERCHANT"
  ) {
    return "Needs your clarification";
  }

  if (input.status === "DUPLICATE") {
    return "Duplicate PO under review";
  }

  if ((input.blockingIssueCount ?? 0) > 0) {
    return "Validation issue under review";
  }

  return "In DraftBridge review";
}

export async function getMerchantExceptionSummary(shopId: string) {
  const orders = await db.purchaseOrder.findMany({
    where: buildMerchantExceptionWhere(shopId),
    select: {
      status: true,
      clarificationNeeded: true,
      validationIssues: {
        select: {
          blocking: true,
        },
      },
      opsCase: {
        select: {
          status: true,
        },
      },
    },
  });

  return summarizeMerchantExceptions(orders);
}

export async function listMerchantExceptionOrders(shopId: string) {
  return db.purchaseOrder.findMany({
    where: buildMerchantExceptionWhere(shopId),
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    include: {
      lineItems: {
        orderBy: { lineNumber: "asc" },
        take: 3,
      },
      validationIssues: {
        orderBy: { createdAt: "asc" },
      },
      draftOrderSync: true,
      opsCase: true,
      sourceDocument: true,
      auditEvents: {
        orderBy: { createdAt: "desc" },
        take: 3,
      },
    },
  });
}
