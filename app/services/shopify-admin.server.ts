import db from "../db.server";
import { apiVersion } from "../shopify.server";

export interface VariantMatchCandidate {
  gid: string;
  legacyId: string;
  sku: string | null;
  title: string;
  productTitle: string;
  price: number | null;
}

export interface CustomerMatchCandidate {
  gid: string;
  legacyId: string;
  displayName: string;
  email: string | null;
}

async function getOfflineAccessToken(shopDomain: string) {
  const offlineSession =
    (await db.session.findFirst({
      where: {
        shop: shopDomain,
        isOnline: false,
      },
    })) ??
    (await db.session.findFirst({
      where: {
        shop: shopDomain,
      },
    }));

  if (!offlineSession) {
    throw new Error(`No Shopify session is available for ${shopDomain}.`);
  }

  return offlineSession.accessToken;
}

async function adminGraphql<T>(shopDomain: string, query: string, variables?: Record<string, unknown>) {
  const accessToken = await getOfflineAccessToken(shopDomain);
  const response = await fetch(
    `https://${shopDomain}/admin/api/${String(apiVersion)}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed with ${response.status}.`);
  }

  const payload = (await response.json()) as T & {
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(" "));
  }

  return payload;
}

async function adminRest<T>(shopDomain: string, path: string, options: RequestInit) {
  const accessToken = await getOfflineAccessToken(shopDomain);
  const response = await fetch(
    `https://${shopDomain}/admin/api/${String(apiVersion)}${path}`,
    {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
        ...(options.headers ?? {}),
      },
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify REST request failed with ${response.status}: ${text}`);
  }

  return (await response.json()) as T;
}

function escapeSearchTerm(value: string) {
  return value.replace(/"/g, '\\"').trim();
}

export async function searchProductVariants(shopDomain: string, term: string) {
  if (!term.trim()) {
    return [];
  }

  const candidateQueries = term.includes(" ")
    ? [term.trim()]
    : [`sku:${escapeSearchTerm(term)}`, escapeSearchTerm(term)];

  const matches: VariantMatchCandidate[] = [];

  for (const queryValue of candidateQueries) {
    const payload = await adminGraphql<{
      data?: {
        productVariants?: {
          edges?: Array<{
            node?: {
              id: string;
              legacyResourceId: string;
              sku?: string | null;
              title: string;
              price?: string | null;
              product?: { title?: string | null } | null;
            };
          }>;
        };
      };
    }>(
      shopDomain,
      `#graphql
        query DraftBridgeProductVariantSearch($query: String!) {
          productVariants(first: 10, query: $query) {
            edges {
              node {
                id
                legacyResourceId
                sku
                title
                price
                product {
                  title
                }
              }
            }
          }
        }`,
      { query: queryValue },
    );

    const result =
      payload.data?.productVariants?.edges
        ?.map((edge) => edge.node)
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
        .map((node) => ({
          gid: node.id,
          legacyId: String(node.legacyResourceId),
          sku: node.sku ?? null,
          title: node.title,
          productTitle: node.product?.title ?? node.title,
          price: node.price ? Number(node.price) : null,
        })) ?? [];

    for (const match of result) {
      if (!matches.find((existing) => existing.gid === match.gid)) {
        matches.push(match);
      }
    }

    if (matches.length > 0) {
      break;
    }
  }

  return matches;
}

export async function searchCustomers(shopDomain: string, term: string) {
  if (!term.trim()) {
    return [];
  }

  try {
    const payload = await adminGraphql<{
      data?: {
        customers?: {
          edges?: Array<{
            node?: {
              id: string;
              legacyResourceId: string;
              displayName: string;
              email?: string | null;
            };
          }>;
        };
      };
    }>(
      shopDomain,
      `#graphql
        query DraftBridgeCustomerSearch($query: String!) {
          customers(first: 10, query: $query) {
            edges {
              node {
                id
                legacyResourceId
                displayName
                email
              }
            }
          }
        }`,
      { query: escapeSearchTerm(term) },
    );

    return (
      payload.data?.customers?.edges
        ?.map((edge) => edge.node)
        .filter((node): node is NonNullable<typeof node> => Boolean(node))
        .map((node) => ({
          gid: node.id,
          legacyId: String(node.legacyResourceId),
          displayName: node.displayName,
          email: node.email ?? null,
        })) ?? []
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (
      message.includes("Customer object") ||
      message.includes("protected-customer-data") ||
      message.includes("ACCESS_DENIED")
    ) {
      return [];
    }

    throw error;
  }
}

export async function createDraftOrder(input: {
  shopDomain: string;
  customerLegacyId?: string | null;
  contactEmail?: string | null;
  note?: string | null;
  poNumber?: string | null;
  lineItems: Array<{
    variantLegacyId: string;
    quantity: number;
    originalUnitPrice?: string | null;
  }>;
}) {
  const payload = await adminRest<{
    draft_order?: {
      id: number;
      name: string;
      invoice_url?: string | null;
    };
  }>(input.shopDomain, "/draft_orders.json", {
    method: "POST",
    body: JSON.stringify({
      draft_order: {
        customer_id: input.customerLegacyId
          ? Number(input.customerLegacyId)
          : undefined,
        email: input.contactEmail ?? undefined,
        note:
          [input.poNumber ? `PO ${input.poNumber}` : null, input.note ?? null]
            .filter(Boolean)
            .join(" | ") || undefined,
        line_items: input.lineItems.map((lineItem) => ({
          variant_id: Number(lineItem.variantLegacyId),
          quantity: lineItem.quantity,
          original_unit_price: lineItem.originalUnitPrice ?? undefined,
        })),
      },
    }),
  });

  if (!payload.draft_order) {
    throw new Error("Shopify did not return a draft order.");
  }

  return payload.draft_order;
}
