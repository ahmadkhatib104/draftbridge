import type { BillingPlan, BillingStatus } from "@prisma/client";

export const BILLING_PAGE_PATH = "/app/billing";
export const DRAFTBRIDGE_TRIAL_DAYS = 14;

export const SHOPIFY_PLAN_NAMES = {
  STARTER: "DraftBridge Starter",
  GROWTH: "DraftBridge Growth",
  SCALE: "DraftBridge Scale",
  ENTERPRISE: "DraftBridge Enterprise",
} as const;

export type PaidBillingPlan = Exclude<BillingPlan, "FREE">;

export interface BillingPlanCatalogEntry {
  billingPlan: PaidBillingPlan;
  shopifyPlan: (typeof SHOPIFY_PLAN_NAMES)[keyof typeof SHOPIFY_PLAN_NAMES];
  label: string;
  monthlyPrice: number;
  priceLabel: string;
  includedUsageLimit: number;
  overagePriceLabel: string;
  summary: string;
}

export const BILLING_PLAN_CATALOG: BillingPlanCatalogEntry[] = [
  {
    billingPlan: "STARTER",
    shopifyPlan: SHOPIFY_PLAN_NAMES.STARTER,
    label: "Starter",
    monthlyPrice: 99,
    priceLabel: "$99/month",
    includedUsageLimit: 25,
    overagePriceLabel: "$3.00 / successful PO",
    summary: "For smaller wholesale teams handling low monthly PO volume.",
  },
  {
    billingPlan: "GROWTH",
    shopifyPlan: SHOPIFY_PLAN_NAMES.GROWTH,
    label: "Growth",
    monthlyPrice: 249,
    priceLabel: "$249/month",
    includedUsageLimit: 100,
    overagePriceLabel: "$2.00 / successful PO",
    summary: "The default plan for merchants processing regular wholesale orders.",
  },
  {
    billingPlan: "SCALE",
    shopifyPlan: SHOPIFY_PLAN_NAMES.SCALE,
    label: "Scale",
    monthlyPrice: 499,
    priceLabel: "$499/month",
    includedUsageLimit: 300,
    overagePriceLabel: "$1.50 / successful PO",
    summary: "For larger ops teams that want a higher included volume before overages.",
  },
  {
    billingPlan: "ENTERPRISE",
    shopifyPlan: SHOPIFY_PLAN_NAMES.ENTERPRISE,
    label: "Enterprise",
    monthlyPrice: 999,
    priceLabel: "$999/month",
    includedUsageLimit: 1000,
    overagePriceLabel: "Custom",
    summary: "For high-volume merchants that need a custom rollout and higher limits.",
  },
];

export function getBillingPlanCatalog() {
  return BILLING_PLAN_CATALOG;
}

export function getPlanCatalogEntry(plan: BillingPlan | null | undefined) {
  if (!plan || plan === "FREE") {
    return null;
  }

  return (
    BILLING_PLAN_CATALOG.find((entry) => entry.billingPlan === plan) ?? null
  );
}

export function getShopifyPlanName(plan: BillingPlan | null | undefined) {
  return getPlanCatalogEntry(plan)?.shopifyPlan ?? null;
}

export function getKnownShopifyPlanNames() {
  return BILLING_PLAN_CATALOG.map((entry) => entry.shopifyPlan);
}

export function getIncludedUsageLimit(plan: BillingPlan | null | undefined) {
  return getPlanCatalogEntry(plan)?.includedUsageLimit ?? 0;
}

export function isBillingActiveStatus(status: BillingStatus | null | undefined) {
  return status === "TRIAL" || status === "ACTIVE";
}
