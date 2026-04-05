import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import db from "../db.server";
import {
  parseSpreadsheetHints,
  SPREADSHEET_HINT_CONFIG,
} from "../services/extraction.server";
import {
  deleteCatalogAlias,
  deleteCustomerAlias,
  saveManualCatalogAlias,
  saveManualCustomerAlias,
  saveSenderProfileMemory,
} from "../services/memory.server";
import { requireShopContext } from "../services/shop-context.server";
import { getPrimaryMailbox } from "../services/shop.server";

function formatTimestamp(value: Date | null) {
  if (!value) {
    return "never";
  }

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

function buildSpreadsheetHintPayload(formData: FormData, senderProfileId: string) {
  return Object.fromEntries(
    SPREADSHEET_HINT_CONFIG.map((config) => {
      const raw = readStringField(formData, `${senderProfileId}:hint:${config.key}`);
      const values = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

      return [config.key, values];
    }).filter(([, values]) => Array.isArray(values) && values.length > 0),
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const [mailbox, senderProfiles, customerAliases] = await Promise.all([
    getPrimaryMailbox(shop.id),
    db.senderProfile.findMany({
      where: { shopId: shop.id },
      orderBy: { lastSeenAt: "desc" },
      include: {
        catalogAliases: {
          orderBy: { updatedAt: "desc" },
          take: 20,
        },
      },
      take: 20,
    }),
    db.customerAlias.findMany({
      where: { shopId: shop.id },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    shop,
    mailbox,
    senderProfiles: senderProfiles.map((profile) => ({
      ...profile,
      lastSeenLabel: formatTimestamp(profile.lastSeenAt),
      parsedSpreadsheetHints: parseSpreadsheetHints(profile.spreadsheetHints),
    })),
    customerAliases: customerAliases.map((alias) => ({
      ...alias,
      updatedAtLabel: formatTimestamp(alias.updatedAt),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, shop } = await requireShopContext(request);
  const associatedUser = session.onlineAccessInfo?.associated_user;
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
  const formData = await request.formData();
  const intent = readStringField(formData, "intent");

  try {
    if (intent === "update-sender-memory") {
      const senderProfileId = readStringField(formData, "senderProfileId");

      if (!senderProfileId) {
        return { ok: false, error: "Missing sender profile id." };
      }

      await saveSenderProfileMemory({
        shopId: shop.id,
        senderProfileId,
        companyName: readStringField(formData, "companyName"),
        customerName: readStringField(formData, "customerName"),
        contactEmail: readStringField(formData, "contactEmail"),
        defaultCurrency: readStringField(formData, "defaultCurrency"),
        sampleSubject: readStringField(formData, "sampleSubject"),
        spreadsheetHints: buildSpreadsheetHintPayload(formData, senderProfileId),
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });

      return {
        ok: true,
        message: "Sender memory updated.",
      };
    }

    if (intent === "add-catalog-alias") {
      const senderProfileId = readStringField(formData, "senderProfileId");

      if (!senderProfileId) {
        return { ok: false, error: "Choose a sender before saving an alias." };
      }

      await saveManualCatalogAlias({
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        senderProfileId,
        aliasType: readStringField(formData, "aliasType") === "DESCRIPTION"
          ? "DESCRIPTION"
          : "CUSTOMER_SKU",
        sourceValue: readStringField(formData, "sourceValue"),
        targetSku: readStringField(formData, "targetSku"),
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });

      return {
        ok: true,
        message: "Catalog alias saved.",
      };
    }

    if (intent === "delete-catalog-alias") {
      const aliasId = readStringField(formData, "aliasId");

      if (!aliasId) {
        return { ok: false, error: "Missing catalog alias id." };
      }

      await deleteCatalogAlias({
        shopId: shop.id,
        aliasId,
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });

      return {
        ok: true,
        message: "Catalog alias deleted.",
      };
    }

    if (intent === "delete-customer-alias") {
      const aliasId = readStringField(formData, "aliasId");

      if (!aliasId) {
        return { ok: false, error: "Missing customer alias id." };
      }

      await deleteCustomerAlias({
        shopId: shop.id,
        aliasId,
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });

      return {
        ok: true,
        message: "Customer alias deleted.",
      };
    }

    if (intent === "add-customer-alias") {
      await saveManualCustomerAlias({
        shopId: shop.id,
        shopDomain: shop.shopDomain,
        aliasType: readStringField(formData, "aliasType") as
          | "CONTACT_EMAIL"
          | "COMPANY_NAME"
          | "SENDER_EMAIL"
          | "SHIP_TO_NAME",
        sourceValue: readStringField(formData, "sourceValue"),
        targetLookup: readStringField(formData, "targetLookup"),
        actorType: "USER",
        actorUserId: actorUser?.id ?? null,
      });

      return {
        ok: true,
        message: "Customer alias saved.",
      };
    }

    return {
      ok: false,
      error: "Unsupported settings action.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Settings update failed.",
    };
  }
};

export default function SettingsRoute() {
  const { mailbox, senderProfiles, customerAliases } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Settings">
        {actionData?.ok ? (
          <s-banner tone="success" heading="Memory updated">
            <s-paragraph>{actionData.message}</s-paragraph>
          </s-banner>
        ) : null}
        {actionData && !actionData.ok ? (
          <s-banner tone="critical" heading="Settings update failed">
            <s-paragraph>{actionData.error}</s-paragraph>
          </s-banner>
        ) : null}

        <s-card heading="Forwarding setup">
          <s-paragraph>Forwarding address: {mailbox.forwardingAddress}</s-paragraph>
          <s-paragraph>
            Set an auto-forward rule in Gmail, Outlook, or your shared ops inbox so retailer purchase orders are sent here automatically.
          </s-paragraph>
          <s-paragraph>When an order needs clarification, your team can track it from the Exceptions tab.</s-paragraph>
        </s-card>

        <s-card heading="Sender memory">
          <s-paragraph>
            DraftBridge remembers sender-specific aliases and spreadsheet column patterns here.
            Use this section to tighten repeat accuracy before a sender’s next order arrives.
          </s-paragraph>
          {senderProfiles.length === 0 ? (
            <s-paragraph>No retailer senders have been learned yet.</s-paragraph>
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              {senderProfiles.map((profile) => (
                <section
                  key={profile.id}
                  style={{
                    border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                    borderRadius: "12px",
                    padding: "1rem",
                  }}
                >
                  <div style={{ marginBottom: "0.75rem" }}>
                    <strong>{profile.senderEmail}</strong>
                    <p style={{ margin: "0.25rem 0 0" }}>
                      {profile.companyName || profile.customerName || "Unknown account"} | Last seen{" "}
                      {profile.lastSeenLabel}
                    </p>
                  </div>

                  <Form method="post" style={{ display: "grid", gap: "0.75rem" }}>
                    <input type="hidden" name="intent" value="update-sender-memory" />
                    <input type="hidden" name="senderProfileId" value={profile.id} />

                    <div
                      style={{
                        display: "grid",
                        gap: "0.75rem",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      }}
                    >
                      <label>
                        Company name
                        <input
                          name="companyName"
                          defaultValue={profile.companyName || ""}
                          style={{ width: "100%" }}
                        />
                      </label>
                      <label>
                        Customer name
                        <input
                          name="customerName"
                          defaultValue={profile.customerName || ""}
                          style={{ width: "100%" }}
                        />
                      </label>
                      <label>
                        Contact email
                        <input
                          name="contactEmail"
                          defaultValue={profile.contactEmail || ""}
                          style={{ width: "100%" }}
                        />
                      </label>
                      <label>
                        Default currency
                        <input
                          name="defaultCurrency"
                          defaultValue={profile.defaultCurrency || ""}
                          style={{ width: "100%" }}
                        />
                      </label>
                      <label style={{ gridColumn: "1 / -1" }}>
                        Sample subject
                        <input
                          name="sampleSubject"
                          defaultValue={profile.sampleSubject || ""}
                          style={{ width: "100%" }}
                        />
                      </label>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gap: "0.75rem",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      }}
                    >
                      {SPREADSHEET_HINT_CONFIG.map((hint) => (
                        <label key={hint.key}>
                          {hint.label}
                          <input
                            name={`${profile.id}:hint:${hint.key}`}
                            defaultValue={profile.parsedSpreadsheetHints[hint.key]?.join(", ") || ""}
                            placeholder="Column names, comma-separated"
                            style={{ width: "100%" }}
                          />
                        </label>
                      ))}
                    </div>

                    <div>
                      <button type="submit" disabled={isSubmitting}>
                        {isSubmitting ? "Saving..." : "Save sender memory"}
                      </button>
                    </div>
                  </Form>

                  <div style={{ marginTop: "1rem" }}>
                    <strong>Learned SKU aliases</strong>
                    {profile.catalogAliases.length === 0 ? (
                      <p style={{ margin: "0.5rem 0 0" }}>No sender-specific aliases saved yet.</p>
                    ) : (
                      <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
                        {profile.catalogAliases.map((alias) => (
                          <div
                            key={alias.id}
                            style={{
                              display: "flex",
                              gap: "0.75rem",
                              alignItems: "center",
                              justifyContent: "space-between",
                              border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                              borderRadius: "10px",
                              padding: "0.75rem",
                            }}
                          >
                            <div>
                              <strong>{alias.aliasType === "CUSTOMER_SKU" ? "Customer SKU" : "Description"}</strong>
                              <p style={{ margin: "0.25rem 0 0" }}>
                                {alias.sourceValue} → {alias.sku || alias.variantId}
                              </p>
                              {alias.title ? (
                                <p style={{ margin: "0.25rem 0 0" }}>{alias.title}</p>
                              ) : null}
                            </div>
                            <Form method="post">
                              <input type="hidden" name="intent" value="delete-catalog-alias" />
                              <input type="hidden" name="aliasId" value={alias.id} />
                              <button type="submit" disabled={isSubmitting}>
                                Delete
                              </button>
                            </Form>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <Form
                    method="post"
                    style={{
                      display: "grid",
                      gap: "0.75rem",
                      marginTop: "1rem",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    }}
                  >
                    <input type="hidden" name="intent" value="add-catalog-alias" />
                    <input type="hidden" name="senderProfileId" value={profile.id} />

                    <label>
                      Alias type
                      <select name="aliasType" defaultValue="CUSTOMER_SKU" style={{ width: "100%" }}>
                        <option value="CUSTOMER_SKU">Customer SKU</option>
                        <option value="DESCRIPTION">Description</option>
                      </select>
                    </label>
                    <label>
                      Source value
                      <input name="sourceValue" placeholder="Buyer SKU or description text" />
                    </label>
                    <label>
                      Shopify SKU
                      <input name="targetSku" placeholder="Exact Shopify variant SKU" />
                    </label>
                    <div style={{ alignSelf: "end" }}>
                      <button type="submit" disabled={isSubmitting}>
                        Add alias
                      </button>
                    </div>
                  </Form>
                </section>
              ))}
            </div>
          )}
        </s-card>

        <s-card heading="Customer mapping memory">
          <Form
            method="post"
            style={{
              display: "grid",
              gap: "0.75rem",
              marginBottom: "1rem",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            <input type="hidden" name="intent" value="add-customer-alias" />
            <label>
              Alias type
              <select name="aliasType" defaultValue="CONTACT_EMAIL" style={{ width: "100%" }}>
                <option value="CONTACT_EMAIL">Contact email</option>
                <option value="COMPANY_NAME">Company name</option>
                <option value="SENDER_EMAIL">Sender email</option>
                <option value="SHIP_TO_NAME">Ship-to name</option>
              </select>
            </label>
            <label>
              Source value
              <input name="sourceValue" placeholder="Value from inbound PO" />
            </label>
            <label>
              Customer lookup
              <input
                name="targetLookup"
                placeholder="Customer email or exact searchable term"
              />
            </label>
            <div style={{ alignSelf: "end" }}>
              <button type="submit" disabled={isSubmitting}>
                Add customer alias
              </button>
            </div>
          </Form>

          {customerAliases.length === 0 ? (
            <s-paragraph>No customer aliases have been learned yet.</s-paragraph>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {customerAliases.map((alias) => (
                <div
                  key={alias.id}
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "center",
                    justifyContent: "space-between",
                    border: "1px solid var(--p-color-border-subdued, #dfe3e8)",
                    borderRadius: "10px",
                    padding: "0.75rem",
                  }}
                >
                  <div>
                    <strong>{alias.aliasType}</strong>
                    <p style={{ margin: "0.25rem 0 0" }}>
                      {alias.sourceValue} → {alias.customerId || alias.companyLocationId || alias.companyId || "Unmatched"}
                    </p>
                    <p style={{ margin: "0.25rem 0 0" }}>Updated {alias.updatedAtLabel}</p>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete-customer-alias" />
                    <input type="hidden" name="aliasId" value={alias.id} />
                    <button type="submit" disabled={isSubmitting}>
                      Delete
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          )}
        </s-card>
      </s-page>
    </div>
  );
}
