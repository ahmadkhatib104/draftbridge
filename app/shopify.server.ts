import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { DRAFTBRIDGE_TRIAL_DAYS, SHOPIFY_PLAN_NAMES } from "./lib/billing";
import { getAppUrl } from "./lib/env.server";
import prisma from "./db.server";

export const DRAFTBRIDGE_STARTER_PLAN = SHOPIFY_PLAN_NAMES.STARTER;
export const DRAFTBRIDGE_GROWTH_PLAN = SHOPIFY_PLAN_NAMES.GROWTH;
export const DRAFTBRIDGE_SCALE_PLAN = SHOPIFY_PLAN_NAMES.SCALE;
export const DRAFTBRIDGE_ENTERPRISE_PLAN = SHOPIFY_PLAN_NAMES.ENTERPRISE;

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: getAppUrl(),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [DRAFTBRIDGE_STARTER_PLAN]: {
      trialDays: DRAFTBRIDGE_TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
        {
          amount: 5000,
          currencyCode: "USD",
          interval: BillingInterval.Usage,
          terms: "$3.00 / successful PO beyond included 25",
        },
      ],
    },
    [DRAFTBRIDGE_GROWTH_PLAN]: {
      trialDays: DRAFTBRIDGE_TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 249,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
        {
          amount: 5000,
          currencyCode: "USD",
          interval: BillingInterval.Usage,
          terms: "$2.00 / successful PO beyond included 100",
        },
      ],
    },
    [DRAFTBRIDGE_SCALE_PLAN]: {
      trialDays: DRAFTBRIDGE_TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 499,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
        {
          amount: 5000,
          currencyCode: "USD",
          interval: BillingInterval.Usage,
          terms: "$1.50 / successful PO beyond included 300",
        },
      ],
    },
    [DRAFTBRIDGE_ENTERPRISE_PLAN]: {
      trialDays: DRAFTBRIDGE_TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: 999,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
