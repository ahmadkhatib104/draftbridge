import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { requireShopContext } from "../services/shop-context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const orders = await db.purchaseOrder.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: {
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
      validationIssues: true,
      draftOrderSync: true,
      opsCase: true,
    },
  });

  return { orders };
};

export default function OrdersRoute() {
  const { orders } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Orders">
        {orders.length === 0 ? (
          <s-card heading="No purchase orders yet">
            <s-paragraph>
              Once your first retailer forwards a PO, it will appear here with status, validation issues, and draft-order details.
            </s-paragraph>
          </s-card>
        ) : (
          <div style={{ display: "grid", gap: "1rem" }}>
            {orders.map((order) => (
              <s-card key={order.id} heading={order.poNumber || "PO pending number"}>
                <s-paragraph>
                  {order.companyName || order.customerName || order.contactEmail || "Unknown customer"}
                </s-paragraph>
                <s-paragraph>
                  Status: {order.status} | Confidence {Math.round(order.finalConfidence * 100)}%
                </s-paragraph>
                <s-paragraph>
                  {order.lineItems.length} line item{order.lineItems.length === 1 ? "" : "s"} | {order.validationIssues.length} issue{order.validationIssues.length === 1 ? "" : "s"}
                </s-paragraph>
                <s-paragraph>
                  {order.draftOrderSync?.shopifyDraftOrderName
                    ? `Draft order ${order.draftOrderSync.shopifyDraftOrderName}`
                    : order.opsCase
                      ? `Ops case ${order.opsCase.status}`
                      : "Pending"}
                </s-paragraph>
                {order.clarificationNeeded ? (
                  <s-paragraph>Clarification can be added from the order detail page.</s-paragraph>
                ) : null}
                <s-paragraph>
                  <Link to={`/app/orders/${order.id}`}>Open details</Link>
                </s-paragraph>
              </s-card>
            ))}
          </div>
        )}
      </s-page>
    </div>
  );
}
