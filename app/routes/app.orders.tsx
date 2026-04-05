import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import db from "../db.server";
import { getMerchantExceptionSummary } from "../services/merchant-exceptions.server";
import { requireShopContext } from "../services/shop-context.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const [orders, exceptionSummary] = await Promise.all([
    db.purchaseOrder.findMany({
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
    }),
    getMerchantExceptionSummary(shop.id),
  ]);

  return { orders, exceptionSummary };
};

export default function OrdersRoute() {
  const { orders, exceptionSummary } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Orders">
        {exceptionSummary.totalCount > 0 ? (
          <s-banner heading="Orders waiting in review">
            <s-paragraph>
              {exceptionSummary.totalCount} order{exceptionSummary.totalCount === 1 ? "" : "s"} still need review or clarification.
            </s-paragraph>
            <s-paragraph>
              Waiting on you: {exceptionSummary.waitingOnMerchantCount} | In review:{" "}
              {exceptionSummary.underReviewCount}
            </s-paragraph>
            <s-paragraph>
              <Link to="/app/exceptions">Open the exception queue</Link>
            </s-paragraph>
          </s-banner>
        ) : null}
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
                      ? `Exception queue ${order.opsCase.status}`
                      : "Pending"}
                </s-paragraph>
                {order.clarificationNeeded ? (
                  <s-paragraph>
                    Clarification can be added from the order detail page or the exception queue.
                  </s-paragraph>
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
