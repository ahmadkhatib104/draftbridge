import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { getOperationalReport } from "../services/reporting.server";
import { requireShopContext } from "../services/shop-context.server";

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function signedPercentDelta(current: number, prior: number) {
  const delta = current - prior;
  return `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const report = await getOperationalReport({
    shopId: shop.id,
  });

  return {
    shop,
    report,
  };
};

export default function ReportingRoute() {
  const { report } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Operational reporting">
        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          }}
        >
          <s-card heading="Current 7-day window">
            <s-paragraph>Orders: {report.current.orderCount}</s-paragraph>
            <s-paragraph>Straight-through: {percent(report.current.straightThroughRate)}</s-paragraph>
            <s-paragraph>Review rate: {percent(report.current.reviewRate)}</s-paragraph>
            <s-paragraph>Failure rate: {percent(report.current.failureRate)}</s-paragraph>
          </s-card>

          <s-card heading="Versus prior window">
            <s-paragraph>
              Straight-through delta: {signedPercentDelta(report.current.straightThroughRate, report.prior.straightThroughRate)}
            </s-paragraph>
            <s-paragraph>
              Review delta: {signedPercentDelta(report.current.reviewRate, report.prior.reviewRate)}
            </s-paragraph>
            <s-paragraph>
              Failure delta: {signedPercentDelta(report.current.failureRate, report.prior.failureRate)}
            </s-paragraph>
          </s-card>

          <s-card heading="Queue aging">
            <div style={{ display: "grid", gap: "0.4rem" }}>
              {report.queueAging.map((bucket) => (
                <s-paragraph key={bucket.label}>
                  {bucket.label}: {bucket.count}
                </s-paragraph>
              ))}
            </div>
          </s-card>
        </div>

        <div
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          }}
        >
          <s-card heading="Drift alerts">
            {report.driftAlerts.length === 0 ? (
              <s-paragraph>No material drift alerts in the current reporting window.</s-paragraph>
            ) : (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {report.driftAlerts.map((alert) => (
                  <div
                    key={`${alert.dimension}-${alert.label}-${alert.metric}`}
                    style={{
                      border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                      borderRadius: "12px",
                      padding: "0.75rem",
                    }}
                  >
                    <strong>
                      {alert.dimension === "SOURCE_KIND" ? "Document type" : "Sender"}: {alert.label}
                    </strong>
                    <p style={{ margin: "0.4rem 0 0" }}>
                      {alert.metric} moved from {percent(alert.priorValue)} to {percent(alert.currentValue)}.
                    </p>
                    <p style={{ margin: "0.25rem 0 0" }}>
                      Sample sizes: {alert.priorCount} prior, {alert.currentCount} current.
                    </p>
                  </div>
                ))}
              </div>
            )}
          </s-card>

          <s-card heading="Top validation issues">
            {report.validationIssues.length === 0 ? (
              <s-paragraph>No validation issues in the current reporting window.</s-paragraph>
            ) : (
              <div style={{ display: "grid", gap: "0.75rem" }}>
                {report.validationIssues.map((issue) => (
                  <div key={issue.code}>
                    <strong>{issue.code}</strong>
                    <p style={{ margin: "0.25rem 0 0" }}>
                      {issue.orderCount} orders | {issue.totalCount} occurrences | {percent(issue.shareOfOrders)} of current orders
                    </p>
                  </div>
                ))}
              </div>
            )}
          </s-card>
        </div>

        <div
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          }}
        >
          <s-card heading="Document-type breakdown">
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {report.sourceKindBreakdown.map((row) => (
                <div key={row.label}>
                  <strong>{row.label}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {row.current.orderCount} current orders | Straight-through {percent(row.current.straightThroughRate)} | Review {percent(row.current.reviewRate)}
                  </p>
                </div>
              ))}
            </div>
          </s-card>

          <s-card heading="Sender breakdown">
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {report.senderBreakdown.map((row) => (
                <div key={row.label}>
                  <strong>{row.label}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {row.current.orderCount} current orders | Straight-through {percent(row.current.straightThroughRate)} | Review {percent(row.current.reviewRate)}
                  </p>
                </div>
              ))}
            </div>
          </s-card>

          <s-card heading="Parse-status breakdown">
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {report.parseStatusBreakdown.map((row) => (
                <div key={row.key}>
                  <strong>
                    {row.sourceKind} / {row.parseStatus}
                  </strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {row.count} orders | {percent(row.shareOfOrders)} of current window
                  </p>
                </div>
              ))}
            </div>
          </s-card>
        </div>
      </s-page>
    </div>
  );
}
