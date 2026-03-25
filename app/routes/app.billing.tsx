import { useEffect } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  BILLING_PAGE_PATH,
  getBillingPlanCatalog,
} from "../lib/billing";
import {
  DRAFTBRIDGE_ENTERPRISE_PLAN,
  DRAFTBRIDGE_GROWTH_PLAN,
  DRAFTBRIDGE_SCALE_PLAN,
  DRAFTBRIDGE_STARTER_PLAN,
} from "../shopify.server";
import {
  buildBillingReturnUrl,
  getBillingDiagnostics,
  getBillingTestMode,
  getBillingUiState,
  normalizeInAppPath,
  requestOfflineBillingConfirmation,
  syncBillingStateIfStale,
} from "../services/billing.server";
import { createAuditEvent } from "../services/audit.server";
import { requireShopContext } from "../services/shop-context.server";

function getRequestedPlan(plan: string) {
  switch (plan) {
    case "STARTER":
      return { billingPlan: "STARTER" as const, shopifyPlan: DRAFTBRIDGE_STARTER_PLAN };
    case "GROWTH":
      return { billingPlan: "GROWTH" as const, shopifyPlan: DRAFTBRIDGE_GROWTH_PLAN };
    case "SCALE":
      return { billingPlan: "SCALE" as const, shopifyPlan: DRAFTBRIDGE_SCALE_PLAN };
    case "ENTERPRISE":
      return { billingPlan: "ENTERPRISE" as const, shopifyPlan: DRAFTBRIDGE_ENTERPRISE_PLAN };
    default:
      return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const returnPath = normalizeInAppPath(
    url.searchParams.get("returnPath") || BILLING_PAGE_PATH,
  );
  const { admin, shop, billing } = await requireShopContext(request);
  let billingState = await syncBillingStateIfStale({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    admin,
    force: Boolean(url.searchParams.get("charge_id")),
  });
  const billingCheck = await billing.check({
    plans: [
      DRAFTBRIDGE_STARTER_PLAN,
      DRAFTBRIDGE_GROWTH_PLAN,
      DRAFTBRIDGE_SCALE_PLAN,
      DRAFTBRIDGE_ENTERPRISE_PLAN,
    ],
    isTest: getBillingTestMode(),
  });
  const activeSubscription = billingCheck.appSubscriptions[0];

  if (
    activeSubscription &&
    (
      billingState?.shopifySubscriptionId !== activeSubscription.id ||
      billingState?.status === "INACTIVE" ||
      billingState?.status === "CANCELED" ||
      billingState?.status === "PAST_DUE" ||
      billingState?.plan === "FREE"
    )
  ) {
    billingState = await syncBillingStateIfStale({
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      admin,
      force: true,
    });
  }

  const billingUi = await getBillingUiState(shop.id, billingState);
  const diagnostics = await getBillingDiagnostics({
    shopId: shop.id,
    billingState,
    admin,
  });

  return {
    billing: billingUi,
    diagnostics,
    plans: getBillingPlanCatalog(),
    returnPath,
    activeSubscriptions: billingCheck.appSubscriptions.map((subscription) => ({
      id: subscription.id,
      name: subscription.name,
      status: subscription.status,
      trialDays: subscription.trialDays,
      test: subscription.test,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, billing, shop } = await requireShopContext(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const returnPath = normalizeInAppPath(
    String(formData.get("returnPath") || BILLING_PAGE_PATH),
  );
  const isTestMode = getBillingTestMode();

  if (intent === "start-plan") {
    const requestedPlan = getRequestedPlan(String(formData.get("plan") || ""));

    if (!requestedPlan) {
      return { ok: false, error: "Select a valid plan before continuing." };
    }

    await createAuditEvent({
      shopId: shop.id,
      entityType: "BILLING",
      entityId: shop.billingState?.id || shop.id,
      action: "BILLING_CHECKOUT_STARTED",
      summary: `Started Shopify billing checkout for ${requestedPlan.billingPlan}.`,
      actorType: "USER",
      metadata: {
        requestedPlan: requestedPlan.billingPlan,
        returnPath,
      },
    });

    try {
      const redirectUrl = await requestOfflineBillingConfirmation({
        shopDomain: shop.shopDomain,
        billingPlan: requestedPlan.billingPlan,
        isTest: isTestMode,
        returnUrl: buildBillingReturnUrl(returnPath, request),
      });

      return {
        ok: true,
        redirectUrl,
      };
    } catch (error) {
      if (error instanceof Response) {
        throw error;
      }

      console.error("Shopify billing request failed", {
        shopDomain: shop.shopDomain,
        requestedPlan: requestedPlan.billingPlan,
        error,
        errorData:
          error && typeof error === "object" && "errorData" in error
            ? error.errorData
            : null,
      });

      return {
        ok: false,
        error:
          error && typeof error === "object" && "errorData" in error &&
          Array.isArray(error.errorData) &&
          typeof error.errorData[0]?.message === "string"
            ? error.errorData[0].message
            : error instanceof Error
              ? error.message
              : "Shopify billing request failed.",
      };
    }
  }

  if (intent === "cancel-plan") {
    const subscriptionId = String(formData.get("subscriptionId") || "");

    if (!subscriptionId) {
      return { ok: false, error: "No subscription ID was provided." };
    }

    try {
      await billing.cancel({
        subscriptionId,
        isTest: isTestMode,
        prorate: false,
      });
      await syncBillingStateIfStale({
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        admin,
        force: true,
      });

      return redirect(BILLING_PAGE_PATH);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not cancel the active plan.",
      };
    }
  }

  return { ok: false, error: "Unsupported billing action." };
};

export default function BillingRoute() {
  const { billing, diagnostics, plans, returnPath, activeSubscriptions } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (
      !actionData ||
      actionData.ok !== true ||
      !("redirectUrl" in actionData) ||
      typeof actionData.redirectUrl !== "string"
    ) {
      return;
    }

    if (window.top) {
      window.top.location.href = actionData.redirectUrl;
      return;
    }

    window.location.href = actionData.redirectUrl;
  }, [actionData]);

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Billing">
        <s-card heading="Current usage">
          <s-paragraph>
            Plan: {billing.planLabel} | Status: {billing.statusLabel}
          </s-paragraph>
          <s-paragraph>
            Successful POs this period: {billing.usageCount} / {billing.includedUsageLimit}
          </s-paragraph>
          <s-paragraph>Overage count: {billing.overageUsageCount}</s-paragraph>
        </s-card>

        <s-card heading="Billing diagnostics">
          <s-paragraph>
            Active subscription: {diagnostics.activeSubscription?.name ?? "None"}
          </s-paragraph>
          <s-paragraph>
            Usage line item attached: {diagnostics.activeSubscription?.hasUsageLineItem ? "Yes" : "No"}
          </s-paragraph>
          <s-paragraph>
            Included successes: {diagnostics.includedSuccessCount} | Overage successes: {diagnostics.overageSuccessCount}
          </s-paragraph>
          <s-paragraph>
            Billed overages: {diagnostics.billedOverageCount} | Pending overages: {diagnostics.pendingOverageCount}
          </s-paragraph>
          {diagnostics.activeSubscription?.usageTerms ? (
            <s-paragraph>{diagnostics.activeSubscription.usageTerms}</s-paragraph>
          ) : null}
        </s-card>

        {actionData?.error ? (
          <s-banner tone="critical" heading="Billing action failed">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        ) : null}

        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          }}
        >
          {plans.map((plan) => (
            <s-card key={plan.billingPlan} heading={`${plan.label} ${plan.priceLabel}`}>
              <s-paragraph>{plan.summary}</s-paragraph>
              <s-paragraph>Included successful POs: {plan.includedUsageLimit}</s-paragraph>
              <s-paragraph>Overage: {plan.overagePriceLabel}</s-paragraph>
              <Form method="post">
                <input type="hidden" name="intent" value="start-plan" />
                <input type="hidden" name="plan" value={plan.billingPlan} />
                <input type="hidden" name="returnPath" value={returnPath} />
                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? "Starting..." : `Start ${plan.label}`}
                </s-button>
              </Form>
            </s-card>
          ))}
        </div>

        {activeSubscriptions.length > 0 ? (
          <s-card heading="Active Shopify subscriptions">
            {activeSubscriptions.map((subscription) => (
              <Form key={subscription.id} method="post" style={{ display: "block", marginBottom: "0.75rem" }}>
                <input type="hidden" name="intent" value="cancel-plan" />
                <input type="hidden" name="subscriptionId" value={subscription.id} />
                <s-paragraph>
                  {subscription.name} | {subscription.status}
                </s-paragraph>
                <s-button type="submit" tone="critical" disabled={isSubmitting}>
                  Cancel subscription
                </s-button>
              </Form>
            ))}
          </s-card>
        ) : null}
      </s-page>
    </div>
  );
}
