import { Prisma, type BillingState } from "@prisma/client";
import db from "../db.server";
import {
  BILLING_PAGE_PATH,
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
    plan?: {
      pricingDetails?: {
        __typename?: string;
        price?: {
          amount?: string;
          currencyCode?: string;
        };
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
              plan {
                pricingDetails {
                  __typename
                  ... on AppRecurringPricing {
                    price {
                      amount
                      currencyCode
                    }
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
    billingState?.includedUsageLimit ?? getIncludedUsageLimit(billingState?.plan);
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
