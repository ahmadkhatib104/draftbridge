import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import {
  describeMerchantExceptionState,
  listMerchantExceptionOrders,
  summarizeMerchantExceptions,
} from "../services/merchant-exceptions.server";
import { requireShopContext } from "../services/shop-context.server";

function formatTimestamp(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const orders = await listMerchantExceptionOrders(shop.id);
  const summary = summarizeMerchantExceptions(orders);

  return {
    summary,
    orders: orders.map((order) => ({
      ...order,
      stateLabel: describeMerchantExceptionState({
        status: order.status,
        clarificationNeeded: order.clarificationNeeded,
        opsCaseStatus: order.opsCase?.status ?? null,
        blockingIssueCount: order.validationIssues.filter((issue) => issue.blocking)
          .length,
      }),
      latestActivityLabel: order.auditEvents[0]
        ? formatTimestamp(order.auditEvents[0].createdAt)
        : null,
    })),
  };
};

export default function ExceptionsRoute() {
  const { summary, orders } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Exceptions">
        <s-card heading="Merchant review queue">
          <s-paragraph>
            DraftBridge keeps uncertain orders visible here until they are resolved. Open any order to add clarification or save corrections.
          </s-paragraph>
          <s-paragraph>
            Open exceptions: {summary.totalCount} | Waiting on you: {summary.waitingOnMerchantCount} | In review:{" "}
            {summary.underReviewCount}
          </s-paragraph>
          <s-paragraph>
            Blocking validation issues: {summary.blockingIssueCount} | Duplicate PO checks: {summary.duplicateCount}
          </s-paragraph>
        </s-card>

        {orders.length === 0 ? (
          <s-card heading="No active exceptions">
            <s-paragraph>
              All unresolved orders have been cleared. New low-confidence POs will appear here if DraftBridge needs review or clarification.
            </s-paragraph>
            <s-paragraph>
              <Link to="/app/orders">Open all orders</Link>
            </s-paragraph>
          </s-card>
        ) : (
          <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
            {orders.map((order) => {
              const blockingIssues = order.validationIssues.filter((issue) => issue.blocking);
              const latestActivity = order.auditEvents[0];

              return (
                <s-card
                  key={order.id}
                  heading={order.poNumber || "PO pending number"}
                >
                  <div style={{ display: "grid", gap: "0.5rem" }}>
                    <s-paragraph>
                      {order.companyName ||
                        order.customerName ||
                        order.contactEmail ||
                        "Unknown customer"}
                    </s-paragraph>
                    <s-paragraph>
                      State: {order.stateLabel} | Confidence {Math.round(order.finalConfidence * 100)}%
                    </s-paragraph>
                    <s-paragraph>
                      Source: {order.sourceDocument.filename || order.sourceDocument.kind} | {order.lineItems.length} line item
                      {order.lineItems.length === 1 ? "" : "s"}
                    </s-paragraph>
                    <s-paragraph>
                      Ops status: {order.opsCase?.status || "OPEN"} | Clarification needed:{" "}
                      {order.clarificationNeeded ? "Yes" : "No"}
                    </s-paragraph>
                    <s-paragraph>
                      {order.opsCase?.summary ||
                        (blockingIssues[0]
                          ? blockingIssues[0].message
                          : "DraftBridge is reviewing this order before creating a draft order.")}
                    </s-paragraph>
                    {blockingIssues.length > 0 ? (
                      <div style={{ display: "grid", gap: "0.35rem" }}>
                        {blockingIssues.slice(0, 3).map((issue) => (
                          <s-paragraph key={issue.id}>
                            {issue.code}: {issue.message}
                          </s-paragraph>
                        ))}
                      </div>
                    ) : null}
                    {latestActivity ? (
                      <s-paragraph>
                        Latest activity: {order.latestActivityLabel} | {latestActivity.summary}
                      </s-paragraph>
                    ) : null}
                    <p style={{ marginTop: "0.5rem" }}>
                      <Link to={`/app/orders/${order.id}`}>
                        Open order details and respond
                      </Link>
                    </p>
                  </div>
                </s-card>
              );
            })}
          </div>
        )}
      </s-page>
    </div>
  );
}
