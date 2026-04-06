import { Prisma, type BillingPlan, type BillingState, type BillingStatus } from "@prisma/client";
import db from "../db.server";
import {
  BILLING_PAGE_PATH,
  DRAFTBRIDGE_FREE_SUCCESS_LIMIT,
  DRAFTBRIDGE_TRIAL_DAYS,
  type PaidBillingPlan,
  getIncludedUsageLimit,
  getPlanCatalogEntry,
  SHOPIFY_PLAN_NAMES,
  isBillingActiveStatus,
} from "../lib/billing";
import { requireAppUrl } from "../lib/env.server";
import { unauthenticated } from "../shopify.server";

const BILLING_SYNC_WINDOW_MS = 5 * 60 * 1000;

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface ActiveSubscription {
  id: string;
  name: string;
  status: string;
  trialDays: number;
  createdAt: string;
  currentPeriodEnd: string | null;
  lineItems: Array<{
    id: string;
    plan?: {
      pricingDetails?: {
        __typename?: string;
        price?: {
          amount?: string;
          currencyCode?: string;
        };
        cappedAmount?: {
          amount?: string;
          currencyCode?: string;
        };
        terms?: string | null;
      } | null;
    } | null;
  }>;
}

interface BillingQueryResponse {
  data?: {
    currentAppInstallation?: {
      activeSubscriptions?: ActiveSubscription[];
    } | null;
  };
}

interface BillingMutationError {
  field?: string[] | null;
  message: string;
}

interface BillingRequestMutationResponse {
  data?: {
    appSubscriptionCreate?: {
      confirmationUrl?: string | null;
      userErrors?: BillingMutationError[];
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

interface UsageRecordMutationResponse {
  data?: {
    appUsageRecordCreate?: {
      appUsageRecord?: {
        id: string;
      } | null;
      userErrors?: BillingMutationError[];
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export interface ActiveSubscriptionDiagnostics {
  id: string;
  name: string;
  status: string;
  trialDays: number;
  currentPeriodEnd: string | null;
  recurringAmount: number | null;
  recurringCurrencyCode: string | null;
  hasUsageLineItem: boolean;
  usageLineItemId: string | null;
  usageTerms: string | null;
  usageCappedAmount: number | null;
  usageCurrencyCode: string | null;
}

export interface BillingDiagnostics {
  activeSubscription: ActiveSubscriptionDiagnostics | null;
  includedSuccessCount: number;
  overageSuccessCount: number;
  billedOverageCount: number;
  pendingOverageCount: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export type BillingGateReason = "FREE_LIMIT_REACHED" | "SUBSCRIPTION_REQUIRED";

export interface BillingGateDecision {
  blocked: boolean;
  reason: BillingGateReason | null;
  message: string | null;
  usageCount: number;
  freeSuccessLimit: number;
  plan: BillingPlan;
  status: BillingStatus;
}

type BillingStateUpsertInput = {
  shopId: string;
  create: Omit<Prisma.BillingStateUncheckedCreateInput, "shopId">;
  update: Prisma.BillingStateUncheckedUpdateInput;
};

export async function upsertBillingStateSafely(input: BillingStateUpsertInput) {
  try {
    return await db.billingState.upsert({
      where: { shopId: input.shopId },
      update: input.update,
      create: {
        shopId: input.shopId,
        ...input.create,
      },
    });
  } catch (error) {
    const isUniqueConflict =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";

    if (!isUniqueConflict) {
      throw error;
    }

    return db.billingState.update({
      where: { shopId: input.shopId },
      data: input.update,
    });
  }
}

export function getBillingTestMode() {
  const override = process.env.SHOPIFY_BILLING_TEST_MODE?.trim().toLowerCase();

  if (override === "true") {
    return true;
  }

  if (override === "false") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

function hasTrialWindowElapsed(billingState: BillingState | null | undefined) {
  if (!billingState?.currentPeriodStart || billingState.status !== "TRIAL") {
    return false;
  }

  return (
    billingState.currentPeriodStart.getTime() +
      DRAFTBRIDGE_TRIAL_DAYS * 24 * 60 * 60 * 1000 <=
    Date.now()
  );
}

export function normalizeInAppPath(path: string | null | undefined) {
  if (!path) {
    return BILLING_PAGE_PATH;
  }

  if (!path.startsWith("/") || path.startsWith("//")) {
    return BILLING_PAGE_PATH;
  }

  return path;
}

export function buildBillingReturnUrl(path: string | null | undefined, request?: Request) {
  const target = new URL(normalizeInAppPath(path), requireAppUrl());

  if (request) {
    const requestUrl = new URL(request.url);

    for (const param of ["embedded", "host", "shop", "locale"]) {
      const value = requestUrl.searchParams.get(param);
      if (value) {
        target.searchParams.set(param, value);
      }
    }
  }

  return target.toString();
}

export function buildBillingGateRedirectPath(input: {
  currentPath: string;
  reason: BillingGateReason;
}) {
  const target = new URL(BILLING_PAGE_PATH, "https://draftbridge.local");
  const currentUrl = new URL(normalizeInAppPath(input.currentPath), "https://draftbridge.local");

  for (const param of ["embedded", "host", "shop", "locale"]) {
    const value = currentUrl.searchParams.get(param);

    if (value) {
      target.searchParams.set(param, value);
    }
  }

  target.searchParams.set("returnPath", normalizeInAppPath(input.currentPath));
  target.searchParams.set("gate", input.reason);
  return `${target.pathname}${target.search}`;
}

export function getBillingGateMessage(reason: BillingGateReason) {
  switch (reason) {
    case "FREE_LIMIT_REACHED":
      return `DraftBridge included ${DRAFTBRIDGE_FREE_SUCCESS_LIMIT} free successful purchase orders. Choose a plan to keep auto-creating draft orders.`;
    case "SUBSCRIPTION_REQUIRED":
      return "DraftBridge billing needs attention before more draft orders can be created. Restart or update your plan to continue processing inbound POs.";
    default:
      return "DraftBridge billing needs attention before more draft orders can be created.";
  }
}

export function evaluateBillingGate(input: {
  plan: BillingPlan | null | undefined;
  status: BillingStatus | null | undefined;
  usageCount: number;
}) {
  const plan = input.plan ?? "FREE";
  const status = input.status ?? "INACTIVE";

  if (isBillingActiveStatus(status)) {
    return {
      blocked: false,
      reason: null,
      message: null,
      usageCount: input.usageCount,
      freeSuccessLimit: DRAFTBRIDGE_FREE_SUCCESS_LIMIT,
      plan,
      status,
    } satisfies BillingGateDecision;
  }

  if (input.usageCount < DRAFTBRIDGE_FREE_SUCCESS_LIMIT) {
    return {
      blocked: false,
      reason: null,
      message: null,
      usageCount: input.usageCount,
      freeSuccessLimit: DRAFTBRIDGE_FREE_SUCCESS_LIMIT,
      plan,
      status,
    } satisfies BillingGateDecision;
  }

  const reason: BillingGateReason =
    plan === "FREE" ? "FREE_LIMIT_REACHED" : "SUBSCRIPTION_REQUIRED";

  return {
    blocked: true,
    reason,
    message: getBillingGateMessage(reason),
    usageCount: input.usageCount,
    freeSuccessLimit: DRAFTBRIDGE_FREE_SUCCESS_LIMIT,
    plan,
    status,
  } satisfies BillingGateDecision;
}

export async function requestOfflineBillingConfirmation(input: {
  shopDomain: string;
  billingPlan: PaidBillingPlan;
  returnUrl: string;
  isTest: boolean;
}) {
  const plan = getPlanCatalogEntry(input.billingPlan);

  if (!plan) {
    throw new Error(`Unknown billing plan ${input.billingPlan}.`);
  }

  const { admin } = await unauthenticated.admin(input.shopDomain);
  const usageLineItems =
    plan.overagePrice === null
      ? []
      : [
          {
            plan: {
              appUsagePricingDetails: {
                cappedAmount: {
                  amount: Math.max(plan.monthlyPrice, 500),
                  currencyCode: "USD",
                },
                terms: `${plan.overagePriceLabel} beyond the included successful PO volume each billing period.`,
              },
            },
          },
        ];
  const response = await admin.graphql(
    `#graphql
      mutation DraftBridgeCreateSubscription(
        $name: String!
        $returnUrl: URL!
        $trialDays: Int
        $lineItems: [AppSubscriptionLineItemInput!]!
        $test: Boolean
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          trialDays: $trialDays
          test: $test
          lineItems: $lineItems
        ) {
          confirmationUrl
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        name: plan.shopifyPlan,
        returnUrl: input.returnUrl,
        trialDays: DRAFTBRIDGE_TRIAL_DAYS,
        test: input.isTest,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: {
                  amount: plan.monthlyPrice,
                  currencyCode: "USD",
                },
                interval: "EVERY_30_DAYS",
              },
            },
          },
          ...usageLineItems,
        ],
      },
    },
  );

  const payload = (await response.json()) as BillingRequestMutationResponse;
  const graphqlError = payload.errors?.find((error) => error.message)?.message;

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const userError = payload.data?.appSubscriptionCreate?.userErrors?.find(
    (error) => error.message,
  );

  if (userError) {
    throw new Error(userError.message);
  }

  const confirmationUrl = payload.data?.appSubscriptionCreate?.confirmationUrl;

  if (!confirmationUrl) {
    throw new Error("Shopify did not return a billing confirmation URL.");
  }

  return confirmationUrl;
}

function amountForSubscription(subscription: ActiveSubscription) {
  for (const lineItem of subscription.lineItems) {
    const amount = Number(lineItem.plan?.pricingDetails?.price?.amount ?? Number.NaN);
    if (!Number.isNaN(amount)) {
      return amount;
    }
  }

  return null;
}

function recurringLineItemForSubscription(subscription: ActiveSubscription | null) {
  if (!subscription) {
    return null;
  }

  return (
    subscription.lineItems.find(
      (entry) => entry.plan?.pricingDetails?.__typename === "AppRecurringPricing",
    ) ?? null
  );
}

function usageLineItemForSubscription(subscription: ActiveSubscription | null) {
  if (!subscription) {
    return null;
  }

  return (
    subscription.lineItems.find(
      (entry) => entry.plan?.pricingDetails?.__typename === "AppUsagePricing",
    ) ?? null
  );
}

function derivePlan(subscription: ActiveSubscription | null) {
  if (!subscription) {
    return "FREE" as const;
  }

  const normalizedName = subscription.name.trim().toLowerCase();
  const amount = amountForSubscription(subscription);

  if (normalizedName === SHOPIFY_PLAN_NAMES.ENTERPRISE.toLowerCase() || amount === 999) {
    return "ENTERPRISE" as const;
  }

  if (normalizedName === SHOPIFY_PLAN_NAMES.SCALE.toLowerCase() || amount === 499) {
    return "SCALE" as const;
  }

  if (normalizedName === SHOPIFY_PLAN_NAMES.GROWTH.toLowerCase() || amount === 249) {
    return "GROWTH" as const;
  }

  if (normalizedName === SHOPIFY_PLAN_NAMES.STARTER.toLowerCase() || amount === 99) {
    return "STARTER" as const;
  }

  return "FREE" as const;
}

function deriveStatus(subscription: ActiveSubscription | null) {
  if (!subscription) {
    return "INACTIVE" as const;
  }

  const normalized = subscription.status.trim().toUpperCase();
  const createdAt = new Date(subscription.createdAt);
  const trialEndsAt = new Date(
    createdAt.getTime() + subscription.trialDays * 24 * 60 * 60 * 1000,
  );

  if (normalized === "FROZEN") {
    return "PAST_DUE" as const;
  }

  if (["CANCELLED", "DECLINED", "EXPIRED"].includes(normalized)) {
    return "CANCELED" as const;
  }

  if (subscription.trialDays > 0 && trialEndsAt > new Date()) {
    return "TRIAL" as const;
  }

  return "ACTIVE" as const;
}

function pickSubscription(subscriptions: ActiveSubscription[]) {
  return subscriptions
    .slice()
    .sort((left, right) => amountForSubscription(right)! - amountForSubscription(left)!)
    .find(Boolean) ?? null;
}

async function queryActiveSubscriptions(admin: AdminGraphqlClient) {
  const response = await admin.graphql(
    `#graphql
      query DraftBridgeBillingStatus {
        currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        trialDays
        createdAt
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                price {
                  amount
                  currencyCode
                }
              }
              ... on AppUsagePricing {
                cappedAmount {
                  amount
                  currencyCode
                }
                terms
              }
            }
          }
        }
      }
        }
      }`,
  );
  const payload = (await response.json()) as BillingQueryResponse;
  return payload.data?.currentAppInstallation?.activeSubscriptions ?? [];
}

function buildActiveSubscriptionDiagnostics(
  subscription: ActiveSubscription | null,
): ActiveSubscriptionDiagnostics | null {
  if (!subscription) {
    return null;
  }

  const recurringLineItem = recurringLineItemForSubscription(subscription);
  const usageLineItem = usageLineItemForSubscription(subscription);

  return {
    id: subscription.id,
    name: subscription.name,
    status: subscription.status,
    trialDays: subscription.trialDays,
    currentPeriodEnd: subscription.currentPeriodEnd,
    recurringAmount: recurringLineItem?.plan?.pricingDetails?.price?.amount
      ? Number(recurringLineItem.plan.pricingDetails.price.amount)
      : null,
    recurringCurrencyCode:
      recurringLineItem?.plan?.pricingDetails?.price?.currencyCode ?? null,
    hasUsageLineItem: Boolean(usageLineItem),
    usageLineItemId: usageLineItem?.id ?? null,
    usageTerms: usageLineItem?.plan?.pricingDetails?.terms ?? null,
    usageCappedAmount: usageLineItem?.plan?.pricingDetails?.cappedAmount?.amount
      ? Number(usageLineItem.plan.pricingDetails.cappedAmount.amount)
      : null,
    usageCurrencyCode:
      usageLineItem?.plan?.pricingDetails?.cappedAmount?.currencyCode ?? null,
  };
}

export async function getActiveSubscriptionDiagnostics(admin: AdminGraphqlClient) {
  const activeSubscriptions = await queryActiveSubscriptions(admin);

  return activeSubscriptions.map((subscription) => buildActiveSubscriptionDiagnostics(subscription)!);
}

export async function syncBillingStateIfStale(input: {
  shopId: string;
  shopDomain: string;
  admin: AdminGraphqlClient;
  force?: boolean;
}) {
  const existing = await db.billingState.findUnique({
    where: { shopId: input.shopId },
  });
  const isFresh =
    existing &&
    !hasTrialWindowElapsed(existing) &&
    Date.now() - existing.updatedAt.getTime() < BILLING_SYNC_WINDOW_MS;

  if (!input.force && isFresh) {
    return existing;
  }

  try {
    const activeSubscriptions = await queryActiveSubscriptions(input.admin);
    const subscription = pickSubscription(activeSubscriptions);
    const plan = derivePlan(subscription);
    const status = deriveStatus(subscription);

    return upsertBillingStateSafely({
      shopId: input.shopId,
      update: {
        plan,
        status,
        shopifySubscriptionId: subscription?.id ?? null,
        currentPeriodStart: subscription ? new Date(subscription.createdAt) : null,
        currentPeriodEnd: subscription?.currentPeriodEnd
          ? new Date(subscription.currentPeriodEnd)
          : null,
        includedUsageLimit: getIncludedUsageLimit(plan),
      },
      create: {
        plan,
        status,
        shopifySubscriptionId: subscription?.id ?? null,
        currentPeriodStart: subscription ? new Date(subscription.createdAt) : null,
        currentPeriodEnd: subscription?.currentPeriodEnd
          ? new Date(subscription.currentPeriodEnd)
          : null,
        includedUsageLimit: getIncludedUsageLimit(plan),
      },
    });
  } catch (error) {
    console.error(`Failed to sync billing for ${input.shopDomain}`, error);
    return (
      existing ??
      upsertBillingStateSafely({
        shopId: input.shopId,
        update: {},
        create: {
          plan: "FREE",
          status: "INACTIVE",
          includedUsageLimit: getIncludedUsageLimit("FREE"),
        },
      })
    );
  }
}

async function getUsageCount(shopId: string, billingState: BillingState | null) {
  const occurredAtFilter = billingState?.currentPeriodStart
    ? { gte: billingState.currentPeriodStart }
    : undefined;

  return db.usageLedger.count({
    where: {
      shopId,
      billable: true,
      ...(occurredAtFilter ? { occurredAt: occurredAtFilter } : {}),
    },
  });
}

export async function getBillingGateDecision(input: {
  shopId: string;
  shopDomain: string;
  admin: AdminGraphqlClient;
}) {
  const billingState = await syncBillingStateIfStale({
    shopId: input.shopId,
    shopDomain: input.shopDomain,
    admin: input.admin,
  });

  const usageCount = await getUsageCount(input.shopId, billingState);
  const effectiveStatus =
    billingState?.status === "TRIAL" && hasTrialWindowElapsed(billingState)
      ? "INACTIVE"
      : billingState?.status;

  return evaluateBillingGate({
    plan: billingState?.plan,
    status: effectiveStatus,
    usageCount,
  });
}

function getStatusLabel(status: BillingState["status"]) {
  switch (status) {
    case "TRIAL":
      return "Trial";
    case "ACTIVE":
      return "Active";
    case "PAST_DUE":
      return "Past due";
    case "CANCELED":
      return "Canceled";
    default:
      return "Inactive";
  }
}

function getTrialDaysRemaining(billingState: BillingState | null) {
  if (!billingState?.currentPeriodStart || billingState.status !== "TRIAL") {
    return null;
  }

  const trialEndsAt = new Date(
    billingState.currentPeriodStart.getTime() +
      DRAFTBRIDGE_TRIAL_DAYS * 24 * 60 * 60 * 1000,
  );
  const diff = trialEndsAt.getTime() - Date.now();

  if (diff <= 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

export async function getBillingUiState(shopId: string, billingState: BillingState | null) {
  const usageCount = await getUsageCount(shopId, billingState);
  const includedUsageLimit =
    billingState?.plan === "FREE"
      ? DRAFTBRIDGE_FREE_SUCCESS_LIMIT
      : billingState?.includedUsageLimit ?? getIncludedUsageLimit(billingState?.plan);
  const overageUsageCount = Math.max(usageCount - includedUsageLimit, 0);
  const planCatalogEntry = getPlanCatalogEntry(billingState?.plan);

  return {
    plan: billingState?.plan ?? "FREE",
    planLabel: planCatalogEntry?.label ?? "Free",
    planPriceLabel: planCatalogEntry?.priceLabel ?? null,
    status: billingState?.status ?? "INACTIVE",
    statusLabel: getStatusLabel(billingState?.status ?? "INACTIVE"),
    billingPagePath: BILLING_PAGE_PATH,
    includedUsageLimit,
    usageCount,
    overageUsageCount,
    needsPlanSelection: !isBillingActiveStatus(billingState?.status),
    currentPeriodEnd: billingState?.currentPeriodEnd?.toISOString() ?? null,
    trialDaysRemaining: getTrialDaysRemaining(billingState),
    isTestMode: getBillingTestMode(),
  };
}

function getUsageLineItemId(subscription: ActiveSubscription | null) {
  return usageLineItemForSubscription(subscription)?.id ?? null;
}

export async function getBillingDiagnostics(input: {
  shopId: string;
  billingState: BillingState | null;
  admin: AdminGraphqlClient;
}) {
  const occurredAtFilter = input.billingState?.currentPeriodStart
    ? {
        gte: input.billingState.currentPeriodStart,
      }
    : undefined;
  const [activeSubscriptions, usageLedger] = await Promise.all([
    queryActiveSubscriptions(input.admin),
    db.usageLedger.findMany({
      where: {
        shopId: input.shopId,
        billable: true,
        ...(occurredAtFilter ? { occurredAt: occurredAtFilter } : {}),
      },
      select: {
        eventType: true,
        billedAt: true,
      },
    }),
  ]);

  const activeSubscription = buildActiveSubscriptionDiagnostics(
    pickSubscription(activeSubscriptions),
  );
  const includedSuccessCount = usageLedger.filter(
    (entry) => entry.eventType === "INCLUDED_SUCCESS",
  ).length;
  const overageRows = usageLedger.filter((entry) => entry.eventType === "OVERAGE_SUCCESS");
  const billedOverageCount = overageRows.filter((entry) => entry.billedAt).length;
  const pendingOverageCount = overageRows.length - billedOverageCount;

  return {
    activeSubscription,
    includedSuccessCount,
    overageSuccessCount: overageRows.length,
    billedOverageCount,
    pendingOverageCount,
    currentPeriodStart: input.billingState?.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd:
      activeSubscription?.currentPeriodEnd ??
      input.billingState?.currentPeriodEnd?.toISOString() ??
      null,
  } satisfies BillingDiagnostics;
}

export async function recordOverageUsageCharge(input: {
  shopDomain: string;
  billingPlan: PaidBillingPlan;
  usageLedgerId: string;
  description: string;
}) {
  const plan = getPlanCatalogEntry(input.billingPlan);

  if (!plan?.overagePrice) {
    return null;
  }

  const { admin } = await unauthenticated.admin(input.shopDomain);
  const activeSubscriptions = await queryActiveSubscriptions(admin);
  const subscription = pickSubscription(activeSubscriptions);
  const subscriptionLineItemId = getUsageLineItemId(subscription);

  if (!subscriptionLineItemId) {
    return null;
  }

  const response = await admin.graphql(
    `#graphql
      mutation DraftBridgeCreateUsageRecord(
        $description: String!
        $idempotencyKey: String!
        $price: MoneyInput!
        $subscriptionLineItemId: ID!
      ) {
        appUsageRecordCreate(
          description: $description
          idempotencyKey: $idempotencyKey
          price: $price
          subscriptionLineItemId: $subscriptionLineItemId
        ) {
          appUsageRecord {
            id
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        description: input.description,
        idempotencyKey: input.usageLedgerId,
        price: {
          amount: plan.overagePrice,
          currencyCode: "USD",
        },
        subscriptionLineItemId,
      },
    },
  );

  const payload = (await response.json()) as UsageRecordMutationResponse;
  const graphqlError = payload.errors?.find((error) => error.message)?.message;

  if (graphqlError) {
    throw new Error(graphqlError);
  }

  const userError = payload.data?.appUsageRecordCreate?.userErrors?.find(
    (error) => error.message,
  );

  if (userError) {
    throw new Error(userError.message);
  }

  return payload.data?.appUsageRecordCreate?.appUsageRecord?.id ?? null;
}
