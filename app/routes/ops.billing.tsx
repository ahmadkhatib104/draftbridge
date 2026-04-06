import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import {
  getBillingDiagnostics,
  getBillingGateDecision,
  getBillingUiState,
  syncBillingStateIfStale,
} from "../services/billing.server";
import { assertOpsAccess, buildOpsPath } from "../services/ops-auth.server";
import { unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  assertOpsAccess(request);

  const shops = await db.shop.findMany({
    where: {
      uninstalledAt: null,
    },
    orderBy: {
      createdAt: "asc",
    },
    include: {
      billingState: true,
    },
  });

  const diagnostics = await Promise.all(
    shops.map(async (shop) => {
      try {
        const { admin } = await unauthenticated.admin(shop.shopDomain);
        const billingState = await syncBillingStateIfStale({
          shopId: shop.id,
          shopDomain: shop.shopDomain,
          admin,
        });
        const [billing, gate, liveDiagnostics] = await Promise.all([
          getBillingUiState(shop.id, billingState),
          getBillingGateDecision({
            shopId: shop.id,
            shopDomain: shop.shopDomain,
            admin,
          }),
          getBillingDiagnostics({
            shopId: shop.id,
            billingState,
            admin,
          }),
        ]);

        return {
          shopDomain: shop.shopDomain,
          billing,
          gate,
          diagnostics: liveDiagnostics,
          error: null,
        };
      } catch (error) {
        return {
          shopDomain: shop.shopDomain,
          billing: null,
          gate: null,
          diagnostics: null,
          error: error instanceof Error ? error.message : "Could not load billing diagnostics.",
        };
      }
    }),
  );

  return {
    casesPath: buildOpsPath(request, "/ops/cases"),
    diagnostics,
  };
};

export default function OpsBillingRoute() {
  const { casesPath, diagnostics } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Billing Diagnostics</h1>
      <p style={{ marginTop: "-0.5rem" }}>
        <a href={casesPath}>Return to ops queue</a>
      </p>
      <div style={{ display: "grid", gap: "1rem" }}>
        {diagnostics.map((entry) => (
          <section
            key={entry.shopDomain}
            style={{
              padding: "1rem",
              border: "1px solid #dfe3e8",
              borderRadius: "12px",
            }}
          >
            <h2 style={{ marginTop: 0 }}>{entry.shopDomain}</h2>
            {entry.error ? (
              <p style={{ color: "#8a1f11" }}>{entry.error}</p>
            ) : null}
            {!entry.billing || !entry.gate || !entry.diagnostics ? null : (
              <>
            <p>
              Plan: {entry.billing.planLabel} | Status: {entry.billing.statusLabel}
            </p>
            <p>
              Successful POs this period: {entry.billing.usageCount} / {entry.billing.includedUsageLimit}
            </p>
            <p>
              Gate status: {entry.gate.blocked ? entry.gate.message : "Open"}
            </p>
            <p>
              Active subscription: {entry.diagnostics.activeSubscription?.name ?? "None"}
            </p>
            <p>
              Usage line item attached: {entry.diagnostics.activeSubscription?.hasUsageLineItem ? "Yes" : "No"}
            </p>
            <p>
              Included successes: {entry.diagnostics.includedSuccessCount} | Overage successes: {entry.diagnostics.overageSuccessCount}
            </p>
            <p>
              Billed overages: {entry.diagnostics.billedOverageCount} | Pending overages: {entry.diagnostics.pendingOverageCount}
            </p>
              </>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
