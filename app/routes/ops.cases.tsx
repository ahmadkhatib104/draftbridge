import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import {
  learnFromPurchaseOrderCorrections,
  savePurchaseOrderCorrections,
} from "../services/memory.server";
import {
  requestMerchantClarification,
  retryPurchaseOrderResolution,
} from "../services/processing.server";

function formatTimestamp(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function assertOpsAccess(request: Request) {
  const expectedToken = process.env.OPS_DASHBOARD_TOKEN?.trim();

  if (!expectedToken) {
    throw new Response("OPS_DASHBOARD_TOKEN is not configured.", { status: 503 });
  }

  const requestUrl = new URL(request.url);
  const providedToken =
    request.headers.get("x-ops-token") || requestUrl.searchParams.get("token");

  if (providedToken !== expectedToken) {
    throw new Response("Unauthorized", { status: 401 });
  }
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  assertOpsAccess(request);

  const cases = await db.opsCase.findMany({
    where: {
      status: {
        in: ["OPEN", "IN_PROGRESS", "WAITING_ON_MERCHANT"],
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    include: {
      purchaseOrder: {
        include: {
          lineItems: {
            orderBy: { lineNumber: "asc" },
          },
          validationIssues: true,
          auditEvents: {
            orderBy: { createdAt: "desc" },
            take: 10,
          },
        },
      },
      shop: true,
    },
  });

  return {
    cases: cases.map((opsCase) => ({
      ...opsCase,
      purchaseOrder: {
        ...opsCase.purchaseOrder,
        auditEvents: opsCase.purchaseOrder.auditEvents.map((event) => ({
          ...event,
          createdAtLabel: formatTimestamp(event.createdAt),
        })),
      },
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  assertOpsAccess(request);

  const formData = await request.formData();
  const intent = readStringField(formData, "intent");
  const purchaseOrderId = readStringField(formData, "purchaseOrderId");

  if (!purchaseOrderId) {
    return {
      ok: false,
      error: "Missing purchase order id.",
    };
  }

  const purchaseOrder = await db.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    include: {
      shop: true,
      lineItems: {
        orderBy: { lineNumber: "asc" },
      },
      opsCase: true,
    },
  });

  if (intent === "save-review" || intent === "retry-review") {
    if (intent === "save-review") {
      const notes = readStringField(formData, "notes");

      await savePurchaseOrderCorrections({
        purchaseOrderId,
        poNumber: readStringField(formData, "poNumber"),
        companyName: readStringField(formData, "companyName"),
        customerName: readStringField(formData, "customerName"),
        contactEmail: readStringField(formData, "contactEmail"),
        currency: readStringField(formData, "currency"),
        notes,
        lineItems: purchaseOrder.lineItems.map((lineItem) => ({
          id: lineItem.id,
          customerSku: readStringField(formData, `customerSku:${lineItem.id}`),
          merchantSku: readStringField(formData, `merchantSku:${lineItem.id}`),
          description: readStringField(formData, `description:${lineItem.id}`),
          quantity: parseOptionalInt(readStringField(formData, `quantity:${lineItem.id}`)),
          unitPrice: parseOptionalDecimal(readStringField(formData, `unitPrice:${lineItem.id}`)),
          uom: readStringField(formData, `uom:${lineItem.id}`),
        })),
      });

      if (purchaseOrder.opsCase) {
        await db.opsCase.update({
          where: { id: purchaseOrder.opsCase.id },
          data: {
            status: "IN_PROGRESS",
            resolutionNotes: notes || null,
          },
        });
      }

      if (formData.get("rememberCorrections") === "on") {
        await learnFromPurchaseOrderCorrections({
          shopId: purchaseOrder.shopId,
          purchaseOrderId,
          shopDomain: purchaseOrder.shop.shopDomain,
          actorType: "OPS",
        });
      }
    }

    await retryPurchaseOrderResolution({
      purchaseOrderId,
      shopDomain: purchaseOrder.shop.shopDomain,
    });

    return { ok: true };
  }

  if (intent === "request-merchant") {
    await requestMerchantClarification({
      shopId: purchaseOrder.shopId,
      purchaseOrderId,
      summary:
        readStringField(formData, "summary") ||
        "Waiting on merchant clarification before DraftBridge can continue.",
    });

    return { ok: true };
  }

  return {
    ok: false,
    error: "Unsupported ops action.",
  };
};

export default function OpsCasesRoute() {
  const { cases } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Ops Queue</h1>
      {actionData && !actionData.ok ? (
        <p style={{ color: "#8a1f11" }}>{actionData.error}</p>
      ) : null}
      {cases.length === 0 ? (
        <p>No open ops cases.</p>
      ) : (
        <div style={{ display: "grid", gap: "1.25rem" }}>
          {cases.map((opsCase) => (
            <section
              key={opsCase.id}
              style={{
                padding: "1rem",
                border: "1px solid #dfe3e8",
                borderRadius: "12px",
              }}
            >
              <h2 style={{ marginTop: 0 }}>
                {opsCase.shop.shopDomain} | {opsCase.purchaseOrder.poNumber || "PO pending number"}
              </h2>
              <p>{opsCase.summary}</p>
              <p>Status: {opsCase.status} | Priority: {opsCase.priority}</p>
              <p>
                {opsCase.purchaseOrder.companyName ||
                  opsCase.purchaseOrder.customerName ||
                  opsCase.purchaseOrder.contactEmail ||
                  "Unknown customer"}
              </p>

              <Form
                id={`save-review-${opsCase.id}`}
                method="post"
                style={{ display: "grid", gap: "0.75rem" }}
              >
                <input type="hidden" name="intent" value="save-review" />
                <input type="hidden" name="purchaseOrderId" value={opsCase.purchaseOrder.id} />

                <div style={{ display: "grid", gap: "0.5rem", gridTemplateColumns: "repeat(4, 1fr)" }}>
                  <label>
                    PO number
                    <input
                      name="poNumber"
                      defaultValue={opsCase.purchaseOrder.poNumber || ""}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label>
                    Company
                    <input
                      name="companyName"
                      defaultValue={opsCase.purchaseOrder.companyName || ""}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label>
                    Customer
                    <input
                      name="customerName"
                      defaultValue={opsCase.purchaseOrder.customerName || ""}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label>
                    Contact email
                    <input
                      name="contactEmail"
                      defaultValue={opsCase.purchaseOrder.contactEmail || ""}
                      style={{ width: "100%" }}
                    />
                  </label>
                  <label>
                    Currency
                    <input
                      name="currency"
                      defaultValue={opsCase.purchaseOrder.currency || ""}
                      style={{ width: "100%" }}
                    />
                  </label>
                </div>

                <div style={{ display: "grid", gap: "0.75rem" }}>
                  {opsCase.purchaseOrder.lineItems.map((lineItem) => (
                    <div
                      key={lineItem.id}
                      style={{
                        display: "grid",
                        gap: "0.5rem",
                        gridTemplateColumns: "1fr 1fr 2fr 0.75fr 0.75fr 0.75fr",
                        alignItems: "end",
                        padding: "0.75rem",
                        border: "1px solid #dfe3e8",
                        borderRadius: "10px",
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
                      <label>
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

                <label>
                  Ops notes
                  <textarea
                    name="notes"
                    defaultValue={opsCase.resolutionNotes || ""}
                    rows={3}
                    style={{ width: "100%" }}
                  />
                </label>

                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input type="checkbox" name="rememberCorrections" defaultChecked />
                  Save these corrections into sender memory before retrying
                </label>

                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                  <button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Saving..." : "Save and retry"}
                  </button>
                </div>
              </Form>

              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
                <Form method="post">
                  <input type="hidden" name="intent" value="retry-review" />
                  <input type="hidden" name="purchaseOrderId" value={opsCase.purchaseOrder.id} />
                  <button type="submit" disabled={isSubmitting}>
                    Retry without edits
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="request-merchant" />
                  <input type="hidden" name="purchaseOrderId" value={opsCase.purchaseOrder.id} />
                  <input
                    type="hidden"
                    name="summary"
                    value="Waiting on merchant clarification before DraftBridge can continue."
                  />
                  <button type="submit" disabled={isSubmitting}>
                    Mark waiting on merchant
                  </button>
                </Form>
              </div>

              {opsCase.purchaseOrder.validationIssues.length > 0 ? (
                <div style={{ marginTop: "1rem" }}>
                  <strong>Validation issues</strong>
                  <ul>
                    {opsCase.purchaseOrder.validationIssues.map((issue) => (
                      <li key={issue.id}>
                        {issue.code}: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {opsCase.purchaseOrder.auditEvents.length > 0 ? (
                <div style={{ marginTop: "1rem" }}>
                  <strong>Recent activity</strong>
                  <ul>
                    {opsCase.purchaseOrder.auditEvents.map((event) => (
                      <li key={event.id}>
                        {event.createdAtLabel} | {event.action} | {event.summary}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
