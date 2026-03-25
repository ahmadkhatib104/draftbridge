import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireShopContext } from "../services/shop-context.server";
import { submitMerchantClarification } from "../services/processing.server";

function formatTimestamp(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

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
      auditEvents: {
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  });

  return {
    order: {
      ...order,
      auditEvents: order.auditEvents.map((event) => ({
        ...event,
        createdAtLabel: formatTimestamp(event.createdAt),
      })),
    },
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session, shop } = await requireShopContext(request);
  const associatedUser = session.onlineAccessInfo?.associated_user;
  const order = await db.purchaseOrder.findFirstOrThrow({
    where: {
      id: params.id,
      shopId: shop.id,
    },
    include: {
      opsCase: true,
    },
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent !== "submit-clarification") {
    return {
      ok: false,
      error: "Unsupported order action.",
    };
  }

  const note = String(formData.get("note") || "").trim();

  if (!note) {
    return {
      ok: false,
      error: "Enter clarification details before sending them to DraftBridge ops.",
    };
  }

  const actorUser = associatedUser?.email
    ? await db.user.findUnique({
        where: {
          shopId_email: {
            shopId: shop.id,
            email: associatedUser.email,
          },
        },
        select: { id: true },
      })
    : null;

  await submitMerchantClarification({
    shopId: shop.id,
    purchaseOrderId: order.id,
    note,
    actorType: "USER",
    actorUserId: actorUser?.id ?? null,
  });

  return { ok: true };
};

export default function OrderDetailRoute() {
  const { order } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading={order.poNumber || "Purchase order detail"}>
        {actionData && !actionData.ok ? (
          <s-banner tone="critical" heading="Clarification not sent">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        ) : null}
        {actionData?.ok ? (
          <s-banner tone="success" heading="Clarification sent">
            <s-paragraph>DraftBridge ops has your latest clarification details.</s-paragraph>
          </s-banner>
        ) : null}

        <s-card heading="Summary">
          <s-paragraph>
            Customer: {order.companyName || order.customerName || order.contactEmail || "Unknown"}
          </s-paragraph>
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
          <s-card heading="Review status">
            <s-paragraph>Status: {order.opsCase.status}</s-paragraph>
            <s-paragraph>{order.opsCase.summary}</s-paragraph>
            <s-paragraph>
              If DraftBridge needs more information, add it here so ops can continue without email ping-pong.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="submit-clarification" />
              <textarea
                name="note"
                rows={4}
                style={{ width: "100%", marginBottom: "0.75rem" }}
                placeholder="Add customer details, corrected SKU references, or any context that will help DraftBridge finish this order."
              />
              <s-button type="submit" variant="primary" disabled={isSubmitting}>
                {isSubmitting ? "Sending..." : "Send clarification"}
              </s-button>
            </Form>
          </s-card>
        ) : null}

        {order.auditEvents.length > 0 ? (
          <s-card heading="Recent activity">
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {order.auditEvents.map((event) => (
                <div key={event.id}>
                  <strong>{event.action}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {event.createdAtLabel} | {event.summary}
                  </p>
                </div>
              ))}
            </div>
          </s-card>
        ) : null}
      </s-page>
    </div>
  );
}
