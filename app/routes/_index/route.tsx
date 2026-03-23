import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { DRAFTBRIDGE_TRIAL_DAYS, getBillingPlanCatalog } from "../../lib/billing";

const fitSignals = [
  "Shopify merchants doing wholesale without heavy ERP or EDI infrastructure.",
  "Ops teams still receiving POs by email, PDF, CSV, or spreadsheet.",
  "Stores where draft-order accuracy matters more than generic document AI claims.",
];

const whySubscribe = [
  "Remove manual re-keying from wholesale order intake.",
  "Validate SKU, quantity, and price before anything becomes a Shopify draft order.",
  "Keep low-confidence orders in a controlled exception workflow instead of risking bad data.",
];

export const meta = () => [
  { title: "DraftBridge | Wholesale PO intake for Shopify" },
  {
    name: "description",
    content:
      "Forward wholesale purchase orders by email or spreadsheet and get validated Shopify draft orders, with only the uncertain cases routed to review.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { plans: getBillingPlanCatalog() };
};

export default function MarketingIndex() {
  const { plans } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "3rem 1.25rem" }}>
      <p style={{ fontFamily: "IBM Plex Mono, monospace", textTransform: "uppercase" }}>
        Wholesale order intake automation for Shopify
      </p>
      <h1 style={{ maxWidth: 760, fontSize: "clamp(2.5rem, 6vw, 4.5rem)", lineHeight: 1 }}>
        Forward messy inbound purchase orders and get validated draft orders in Shopify.
      </h1>
      <p style={{ maxWidth: 720, fontSize: "1.1rem", lineHeight: 1.7 }}>
        DraftBridge ingests emailed wholesale POs, parses PDFs and spreadsheets, matches line items to Shopify variants,
        validates price and quantity, and creates draft orders automatically only when confidence is high.
      </p>

      <Form method="post" action="/auth/login" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginTop: "1.5rem" }}>
        <label style={{ display: "grid", gap: "0.25rem", minWidth: 280 }}>
          <span>Shop domain</span>
          <input
            type="text"
            name="shop"
            placeholder="example.myshopify.com"
            style={{ padding: "0.85rem 1rem", borderRadius: 12, border: "1px solid #c7ccd1" }}
          />
        </label>
        <button
          type="submit"
          style={{
            alignSelf: "end",
            padding: "0.9rem 1.2rem",
            borderRadius: 999,
            border: 0,
            background: "#172b4d",
            color: "white",
            fontWeight: 600,
          }}
        >
          Open embedded app
        </button>
      </Form>

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", marginTop: "2rem" }}>
        <section>
          <h2>Best fit</h2>
          <ul>
            {fitSignals.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Why teams buy</h2>
          <ul>
            {whySubscribe.map((signal) => (
              <li key={signal}>{signal}</li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Trial</h2>
          <p>{DRAFTBRIDGE_TRIAL_DAYS}-day free trial on paid plans.</p>
        </section>
      </div>

      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginTop: "2rem" }}>
        {plans.map((plan) => (
          <section key={plan.billingPlan} style={{ border: "1px solid #dfe3e8", borderRadius: 16, padding: "1rem" }}>
            <h2 style={{ marginTop: 0 }}>
              {plan.label} <span style={{ float: "right" }}>{plan.priceLabel}</span>
            </h2>
            <p>{plan.summary}</p>
            <p>Included successful POs: {plan.includedUsageLimit}</p>
            <p>Overage: {plan.overagePriceLabel}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
