import { unauthenticated } from "../shopify.server";

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
}

function isRecoverableShopifyReadError(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  return (
    message.includes("No Shopify session is available") ||
    message.includes("Could not find a session for shop") ||
    message.includes("Shopify GraphQL request failed with 401") ||
    message.includes("Customer object") ||
    message.includes("protected-customer-data") ||
    message.includes("ACCESS_DENIED")
  );
}

async function adminGraphql<T>(shopDomain: string, query: string, variables?: Record<string, unknown>) {
  const { admin } = await unauthenticated.admin(shopDomain);
  const response = await admin.graphql(query, {
    variables,
  });

  const payload = (await response.json()) as T & {
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(" "));
  }

  return payload;
}

function escapeSearchTerm(value: string) {
  return value.replace(/"/g, '\\"').trim();
}

export async function searchProductVariants(shopDomain: string, term: string) {
  if (!term.trim()) {
    return [];
  }

  try {
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
  } catch (error) {
    if (isRecoverableShopifyReadError(error)) {
      return [];
    }

    throw error;
  }
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
        })) ?? []
    );
  } catch (error) {
    if (isRecoverableShopifyReadError(error)) {
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
  currencyCode?: string | null;
  lineItems: Array<{
    variantLegacyId: string;
    quantity: number;
    originalUnitPrice?: string | null;
  }>;
}) {
  const payload = await adminGraphql<{
    data?: {
      draftOrderCreate?: {
        draftOrder?: {
          id: string;
          name: string;
          invoiceUrl?: string | null;
        } | null;
        userErrors?: Array<{
          field?: string[] | null;
          message?: string | null;
        }> | null;
      } | null;
    };
  }>(
    input.shopDomain,
    `#graphql
      mutation DraftBridgeDraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            invoiceUrl
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      input: {
        ...(input.customerLegacyId
          ? {
              purchasingEntity: {
                customerId: toShopifyGid("Customer", input.customerLegacyId),
              },
            }
          : {}),
        email: input.contactEmail ?? undefined,
        note:
          [input.poNumber ? `PO ${input.poNumber}` : null, input.note ?? null]
            .filter(Boolean)
            .join(" | ") || undefined,
        poNumber: input.poNumber ?? undefined,
        sourceName: "draftbridge",
        lineItems: input.lineItems.map((lineItem) => ({
          variantId: toShopifyGid("ProductVariant", lineItem.variantLegacyId),
          quantity: lineItem.quantity,
          ...(lineItem.originalUnitPrice
            ? {
                originalUnitPriceWithCurrency: {
                  amount: lineItem.originalUnitPrice,
                  currencyCode: input.currencyCode ?? "USD",
                },
              }
            : {}),
        })),
      },
    },
  );

  const userError = payload.data?.draftOrderCreate?.userErrors?.find((error) => error.message);

  if (userError?.message) {
    throw new Error(userError.message);
  }

  const draftOrder = payload.data?.draftOrderCreate?.draftOrder;

  if (!draftOrder) {
    throw new Error("Shopify did not return a draft order.");
  }

  return draftOrder;
}

export async function getVariantByLegacyId(shopDomain: string, legacyId: string) {
  const payload = await adminGraphql<{
    data?: {
      productVariant?: {
        id: string;
        legacyResourceId: string;
        sku?: string | null;
        title: string;
        price?: string | null;
        product?: { title?: string | null } | null;
      } | null;
    };
  }>(
    shopDomain,
    `#graphql
      query DraftBridgeVariantById($id: ID!) {
        productVariant(id: $id) {
          id
          legacyResourceId
          sku
          title
          price
          product {
            title
          }
        }
      }`,
    {
      id: toShopifyGid("ProductVariant", legacyId),
    },
  );

  const variant = payload.data?.productVariant;

  if (!variant) {
    return null;
  }

  return {
    gid: variant.id,
    legacyId: String(variant.legacyResourceId),
    sku: variant.sku ?? null,
    title: variant.title,
    productTitle: variant.product?.title ?? variant.title,
    price: variant.price ? Number(variant.price) : null,
  } satisfies VariantMatchCandidate;
}

function toShopifyGid(resource: "Customer" | "ProductVariant", value: string) {
  return value.startsWith("gid://shopify/") ? value : `gid://shopify/${resource}/${value}`;
}
