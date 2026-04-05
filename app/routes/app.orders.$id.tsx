import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import { requireShopContext } from "../services/shop-context.server";
import {
  learnFromPurchaseOrderCorrections,
  savePurchaseOrderCorrections,
} from "../services/memory.server";
import {
  retryPurchaseOrderResolution,
  submitMerchantClarification,
} from "../services/processing.server";

function formatTimestamp(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function readStringField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function parseOptionalInt(value: string) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalDecimal(value: string) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
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
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
    },
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

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

  if (intent === "submit-clarification") {
    const note = readStringField(formData, "note");

    if (!note) {
      return {
        ok: false,
        error: "Enter clarification details before sending them to DraftBridge ops.",
      };
    }

    await submitMerchantClarification({
      shopId: shop.id,
      purchaseOrderId: order.id,
      note,
      actorType: "USER",
      actorUserId: actorUser?.id ?? null,
    });

    return { ok: true, message: "Clarification sent to DraftBridge ops." };
  }

  if (intent === "save-corrections") {
    await savePurchaseOrderCorrections({
      purchaseOrderId: order.id,
      poNumber: readStringField(formData, "poNumber"),
      companyName: readStringField(formData, "companyName"),
      customerName: readStringField(formData, "customerName"),
      contactEmail: readStringField(formData, "contactEmail"),
      currency: readStringField(formData, "currency"),
      notes: readStringField(formData, "notes"),
      lineItems: order.lineItems.map((lineItem) => ({
        id: lineItem.id,
        customerSku: readStringField(formData, `customerSku:${lineItem.id}`),
        merchantSku: readStringField(formData, `merchantSku:${lineItem.id}`),
        description: readStringField(formData, `description:${lineItem.id}`),
        quantity: parseOptionalInt(readStringField(formData, `quantity:${lineItem.id}`)),
        unitPrice: parseOptionalDecimal(readStringField(formData, `unitPrice:${lineItem.id}`)),
        uom: readStringField(formData, `uom:${lineItem.id}`),
      })),
    });

    if (formData.get("rememberCorrections") === "on") {
      await learnFromPurchaseOrderCorrections({
        shopId: shop.id,
        purchaseOrderId: order.id,
        shopDomain: shop.shopDomain,
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });
    }

    await retryPurchaseOrderResolution({
      purchaseOrderId: order.id,
      shopDomain: shop.shopDomain,
    });

    return {
      ok: true,
      message: "Corrections saved and DraftBridge retried the order.",
    };
  }

  return {
    ok: false,
    error: "Unsupported order action.",
  };
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
          <s-banner tone="success" heading="Update saved">
            <s-paragraph>{actionData.message}</s-paragraph>
          </s-banner>
        ) : null}
        {order.status !== "AUTO_DRAFTED" ? (
          <s-banner heading="This order is in your exception queue">
            <s-paragraph>
              DraftBridge is holding this order for review instead of risking a bad draft order.
            </s-paragraph>
            <s-paragraph>
              <Link to="/app/exceptions">Back to exception queue</Link>
            </s-paragraph>
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

        {order.status !== "AUTO_DRAFTED" ? (
          <s-card heading="Correct this order">
            <s-paragraph>
              Fix the fields below, then let DraftBridge retry the order. Keep
              &quot;remember corrections&quot; enabled so repeat orders from this sender get
              easier instead of failing the same way again.
            </s-paragraph>
            <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
              <input type="hidden" name="intent" value="save-corrections" />

              <div
                style={{
                  display: "grid",
                  gap: "0.75rem",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                }}
              >
                <label>
                  PO number
                  <input name="poNumber" defaultValue={order.poNumber || ""} style={{ width: "100%" }} />
                </label>
                <label>
                  Company
                  <input name="companyName" defaultValue={order.companyName || ""} style={{ width: "100%" }} />
                </label>
                <label>
                  Customer
                  <input name="customerName" defaultValue={order.customerName || ""} style={{ width: "100%" }} />
                </label>
                <label>
                  Contact email
                  <input name="contactEmail" defaultValue={order.contactEmail || ""} style={{ width: "100%" }} />
                </label>
                <label>
                  Currency
                  <input name="currency" defaultValue={order.currency || ""} style={{ width: "100%" }} />
                </label>
                <label style={{ gridColumn: "1 / -1" }}>
                  Notes
                  <textarea
                    name="notes"
                    rows={3}
                    defaultValue={order.notes || ""}
                    style={{ width: "100%" }}
                  />
                </label>
              </div>

              <div style={{ display: "grid", gap: "0.75rem" }}>
                {order.lineItems.map((lineItem) => (
                  <div
                    key={lineItem.id}
                    style={{
                      display: "grid",
                      gap: "0.5rem",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      alignItems: "end",
                      padding: "0.75rem",
                      border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                      borderRadius: "12px",
                    }}
                  >
                    <label>
                      Customer SKU
                      <input
                        name={`customerSku:${lineItem.id}`}
                        defaultValue={lineItem.customerSku || ""}
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label>
                      Merchant SKU
                      <input
                        name={`merchantSku:${lineItem.id}`}
                        defaultValue={lineItem.merchantSku || ""}
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label style={{ gridColumn: "span 2" }}>
                      Description
                      <input
                        name={`description:${lineItem.id}`}
                        defaultValue={lineItem.description || ""}
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label>
                      Qty
                      <input
                        name={`quantity:${lineItem.id}`}
                        defaultValue={lineItem.quantity ?? ""}
                        inputMode="numeric"
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label>
                      Unit price
                      <input
                        name={`unitPrice:${lineItem.id}`}
                        defaultValue={lineItem.unitPrice?.toString() ?? ""}
                        inputMode="decimal"
                        style={{ width: "100%" }}
                      />
                    </label>
                    <label>
                      UOM
                      <input
                        name={`uom:${lineItem.id}`}
                        defaultValue={lineItem.uom || ""}
                        style={{ width: "100%" }}
                      />
                    </label>
                  </div>
                ))}
              </div>

              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input type="checkbox" name="rememberCorrections" defaultChecked />
                Remember these corrections for future orders from this sender
              </label>

              <div>
                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save corrections and retry"}
                </s-button>
              </div>
            </Form>
          </s-card>
        ) : null}

        {order.opsCase ? (
          <s-card heading="Review status">
            <s-paragraph>Status: {order.opsCase.status}</s-paragraph>
            <s-paragraph>{order.opsCase.summary}</s-paragraph>
            <s-paragraph>
              This order also appears in your exception queue so your team can see what is waiting on DraftBridge and add clarification without email ping-pong.
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
