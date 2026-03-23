import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { requireShopContext } from "../services/shop-context.server";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const order = await db.purchaseOrder.findFirstOrThrow({
    where: {
      id: params.id,
      shopId: shop.id,
    },
    include: {
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
      validationIssues: {
        orderBy: { createdAt: "asc" },
      },
      draftOrderSync: true,
      opsCase: true,
      sourceDocument: true,
    },
  });

  return { order };
};

export default function OrderDetailRoute() {
  const { order } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading={order.poNumber || "Purchase order detail"}>
        <s-card heading="Summary">
          <s-paragraph>Customer: {order.companyName || order.customerName || order.contactEmail || "Unknown"}</s-paragraph>
          <s-paragraph>Status: {order.status}</s-paragraph>
          <s-paragraph>Confidence: {Math.round(order.finalConfidence * 100)}%</s-paragraph>
          <s-paragraph>Source: {order.sourceDocument.filename || order.sourceDocument.kind}</s-paragraph>
          <s-paragraph>
            Draft order: {order.draftOrderSync?.shopifyDraftOrderName || order.draftOrderSync?.status || "Not created"}
          </s-paragraph>
        </s-card>

        <s-card heading="Line items">
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {order.lineItems.map((lineItem) => (
              <div
                key={lineItem.id}
                style={{
                  padding: "0.75rem",
                  border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                  borderRadius: "12px",
                }}
              >
                <p style={{ margin: 0 }}>
                  Line {lineItem.lineNumber}: {lineItem.description || lineItem.merchantSku || lineItem.customerSku || "Unknown item"}
                </p>
                <p style={{ margin: "0.25rem 0 0" }}>
                  Qty {lineItem.quantity ?? "?"} | Price {lineItem.unitPrice?.toString() ?? "?"} | Match {lineItem.matchedSku || "Not matched"}
                </p>
                <p style={{ margin: "0.25rem 0 0" }}>
                  Validation status: {lineItem.validationStatus}
                </p>
              </div>
            ))}
          </div>
        </s-card>

        <s-card heading="Validation issues">
          {order.validationIssues.length === 0 ? (
            <s-paragraph>No validation issues were recorded.</s-paragraph>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {order.validationIssues.map((issue) => (
                <div key={issue.id}>
                  <strong>{issue.code}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {issue.message} {issue.blocking ? "(blocking)" : "(non-blocking)"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </s-card>

        {order.opsCase ? (
          <s-card heading="Ops review">
            <s-paragraph>Status: {order.opsCase.status}</s-paragraph>
            <s-paragraph>{order.opsCase.summary}</s-paragraph>
          </s-card>
        ) : null}
      </s-page>
    </div>
  );
}
