import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import {
  getBillingDiagnostics,
  getBillingUiState,
  syncBillingStateIfStale,
} from "../services/billing.server";
import { getOperationalReport } from "../services/reporting.server";
import { requireShopContext } from "../services/shop-context.server";
import { getDashboardSnapshot } from "../services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, shop } = await requireShopContext(request);
  const billingState = await syncBillingStateIfStale({
    shopId: shop.id,
    shopDomain: shop.shopDomain,
    admin,
  });
  const [billing, dashboard] = await Promise.all([
    getBillingUiState(shop.id, billingState),
    getDashboardSnapshot(shop.id),
  ]);
  const [billingDiagnostics, report] = await Promise.all([
    getBillingDiagnostics({
      shopId: shop.id,
      billingState,
      admin,
    }),
    getOperationalReport({
      shopId: shop.id,
    }),
  ]);

  return {
    shop,
    billing,
    billingDiagnostics,
    dashboard,
    report,
  };
};

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export default function AppIndex() {
  const { shop, billing, billingDiagnostics, dashboard, report } =
    useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Inbound wholesale order automation">
        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <s-card heading="Forwarding mailbox">
            <s-paragraph>{dashboard.mailbox.forwardingAddress}</s-paragraph>
            <s-paragraph>
              Share this address with retailer contacts or use it as a forwarding target from your ops inbox.
            </s-paragraph>
          </s-card>
          <s-card heading="Current plan">
            <s-paragraph>{billing.planLabel}</s-paragraph>
            <s-paragraph>
              {billing.planPriceLabel ?? "No active recurring plan"} | {billing.statusLabel}
            </s-paragraph>
            <s-paragraph>
              Successful POs this period: {billing.usageCount} / {billing.includedUsageLimit}
            </s-paragraph>
          </s-card>
          <s-card heading="Open ops cases">
            <s-paragraph>{dashboard.merchantExceptionSummary.totalCount}</s-paragraph>
            <s-paragraph>
              Low-confidence orders stay visible in your exception queue while DraftBridge ops reviews them.
            </s-paragraph>
            <s-paragraph>
              Waiting on you: {dashboard.merchantExceptionSummary.waitingOnMerchantCount} | In review:{" "}
              {dashboard.merchantExceptionSummary.underReviewCount}
            </s-paragraph>
            <p style={{ marginTop: "0.5rem" }}>
              <Link to="/app/exceptions">Open exception queue</Link>
            </p>
          </s-card>
          <s-card heading="Shop">
            <s-paragraph>{shop.shopDomain}</s-paragraph>
            <s-paragraph>Onboarding status: {shop.onboardingStatus}</s-paragraph>
          </s-card>
        </div>

        <div
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "2fr 1fr",
          }}
        >
          <s-card heading="Recent purchase orders">
            {dashboard.recentOrders.length === 0 ? (
              <s-paragraph>No purchase orders have been processed yet.</s-paragraph>
            ) : (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {dashboard.recentOrders.map((order) => (
                  <div
                    key={order.id}
                    style={{
                      padding: "0.75rem",
                      border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                      borderRadius: "12px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "1rem",
                        alignItems: "center",
                      }}
                    >
                      <strong>{order.poNumber || "PO pending number"}</strong>
                      <s-badge>{order.status}</s-badge>
                    </div>
                    <p style={{ margin: "0.5rem 0" }}>
                      {order.companyName || order.customerName || order.contactEmail || "Unknown customer"}
                    </p>
                    <p style={{ margin: 0 }}>
                      {order.lineItems.length} line item{order.lineItems.length === 1 ? "" : "s"} | Confidence {Math.round(order.finalConfidence * 100)}%
                    </p>
                    <p style={{ marginTop: "0.5rem" }}>
                      <Link to={`/app/orders/${order.id}`}>Open order details</Link>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </s-card>

          <s-card heading="Recent audit trail">
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {dashboard.auditEvents.map((event) => (
                <div key={event.id}>
                  <strong>{event.action}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>{event.summary}</p>
                </div>
              ))}
            </div>
          </s-card>
        </div>

        <div
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          }}
        >
          <s-card heading="7-day straight-through">
            <s-paragraph>{percent(report.current.straightThroughRate)}</s-paragraph>
            <s-paragraph>
              {report.current.autoDraftedCount} auto-drafted out of {report.current.orderCount} orders.
            </s-paragraph>
            <s-paragraph>
              Review rate {percent(report.current.reviewRate)} | Failure rate {percent(report.current.failureRate)}
            </s-paragraph>
          </s-card>

          <s-card heading="Usage billing">
            <s-paragraph>
              Usage line item attached: {billingDiagnostics.activeSubscription?.hasUsageLineItem ? "Yes" : "No"}
            </s-paragraph>
            <s-paragraph>
              Included successes: {billingDiagnostics.includedSuccessCount} | Overage successes: {billingDiagnostics.overageSuccessCount}
            </s-paragraph>
            <s-paragraph>
              Billed overages: {billingDiagnostics.billedOverageCount} | Pending: {billingDiagnostics.pendingOverageCount}
            </s-paragraph>
          </s-card>

          <s-card heading="Current drift alerts">
            {report.driftAlerts.length === 0 ? (
              <s-paragraph>No material drift alerts in the latest 7-day window.</s-paragraph>
            ) : (
              <div style={{ display: "grid", gap: "0.5rem" }}>
                {report.driftAlerts.slice(0, 3).map((alert) => (
                  <s-paragraph key={`${alert.dimension}-${alert.label}-${alert.metric}`}>
                    {alert.label}: {alert.metric} {percent(alert.currentValue)} vs {percent(alert.priorValue)}
                  </s-paragraph>
                ))}
              </div>
            )}
            <p style={{ marginTop: "0.5rem" }}>
              <Link to="/app/reporting">Open detailed reporting</Link>
            </p>
          </s-card>
        </div>
      </s-page>
    </div>
  );
}
