import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import {
  EmbeddedNavLink,
} from "../components/embedded-navigation";
import { APP_NAVIGATION } from "../lib/product";
import {
  BILLING_PAGE_PATH,
} from "../lib/billing";
import {
  buildBillingGateRedirectPath,
  getBillingGateDecision,
  getBillingUiState,
  syncBillingStateIfStale,
} from "../services/billing.server";
import { requireShopContext } from "../services/shop-context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await requireShopContext(request);
  const requestUrl = new URL(request.url);
  const gate = await getBillingGateDecision({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    admin,
  });

  if (gate.blocked && requestUrl.pathname !== BILLING_PAGE_PATH) {
    throw redirect(
      buildBillingGateRedirectPath({
        currentPath: `${requestUrl.pathname}${requestUrl.search}`,
        reason: gate.reason ?? "SUBSCRIPTION_REQUIRED",
      }),
    );
  }

  const billingState = await syncBillingStateIfStale({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    admin,
  });
  const billing = await getBillingUiState(shop.id, billingState);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain: shop.shopDomain,
    billing,
  };
};

export default function App() {
  const { apiKey, shopDomain, billing } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {APP_NAVIGATION.map((item) => (
          <EmbeddedNavLink key={item.href} to={item.href}>
            {item.label}
          </EmbeddedNavLink>
        ))}
      </s-app-nav>
      <div style={{ padding: "0 1rem 1rem" }}>
        <s-banner
          heading={
            billing.needsPlanSelection
              ? "Start your 14-day trial to turn inbound POs into draft orders"
              : billing.status === "TRIAL"
                ? `Trial active${billing.trialDaysRemaining ? `: ${billing.trialDaysRemaining} day${billing.trialDaysRemaining === 1 ? "" : "s"} remaining` : ""}`
                : `Plan active: ${billing.planLabel}`
          }
        >
          <s-paragraph>
            Connected shop: <s-text>{shopDomain}</s-text>
          </s-paragraph>
          <s-paragraph>
            DraftBridge turns emailed wholesale purchase orders into validated draft orders inside Shopify.
          </s-paragraph>
          <s-paragraph>
            Billing state: <s-text>{billing.planLabel}</s-text> | <s-text>{billing.statusLabel}</s-text>
          </s-paragraph>
          <s-paragraph>
            Included successful POs this period: <s-text>{billing.includedUsageLimit}</s-text> | Used: <s-text>{billing.usageCount}</s-text>
          </s-paragraph>
          <s-paragraph>
            <EmbeddedNavLink to={billing.billingPagePath}>
              {billing.needsPlanSelection ? "Choose plan and start trial" : "Manage plan"}
            </EmbeddedNavLink>
          </s-paragraph>
        </s-banner>
      </div>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
