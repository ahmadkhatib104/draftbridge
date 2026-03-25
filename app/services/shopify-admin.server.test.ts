import { beforeEach, describe, expect, it, vi } from "vitest";

const { adminMock, graphqlMock } = vi.hoisted(() => ({
  adminMock: vi.fn(),
  graphqlMock: vi.fn(),
}));

vi.mock("../shopify.server", () => ({
  unauthenticated: {
    admin: adminMock,
  },
}));

import { createDraftOrder, searchCustomers } from "./shopify-admin.server";

describe("shopify admin service", () => {
  beforeEach(() => {
    graphqlMock.mockReset();
    adminMock.mockReset();
    adminMock.mockResolvedValue({
      admin: {
        graphql: graphqlMock,
      },
    });
  });

  it("creates draft orders through GraphQL with Shopify gids and currency-aware pricing", async () => {
    graphqlMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/42",
                name: "#D42",
                invoiceUrl: "https://example.com/invoice",
              },
              userErrors: [],
            },
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const draftOrder = await createDraftOrder({
      shopDomain: "example.myshopify.com",
      customerLegacyId: "123",
      contactEmail: "buyer@example.com",
      note: "Deliver ASAP",
      poNumber: "PO-42",
      currencyCode: "USD",
      lineItems: [
        {
          variantLegacyId: "456",
          quantity: 2,
          originalUnitPrice: "18.00",
        },
      ],
    });

    expect(adminMock).toHaveBeenCalledWith("example.myshopify.com");

    const [query, options] = graphqlMock.mock.calls[0] ?? [];
    expect(query).toContain("mutation DraftBridgeDraftOrderCreate");
    expect(options?.variables).toEqual({
      input: {
        purchasingEntity: {
          customerId: "gid://shopify/Customer/123",
        },
        email: "buyer@example.com",
        note: "PO PO-42 | Deliver ASAP",
        poNumber: "PO-42",
        sourceName: "draftbridge",
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/456",
            quantity: 2,
            originalUnitPriceWithCurrency: {
              amount: "18.00",
              currencyCode: "USD",
            },
          },
        ],
      },
    });

    expect(draftOrder).toEqual({
      id: "gid://shopify/DraftOrder/42",
      name: "#D42",
      invoiceUrl: "https://example.com/invoice",
    });
  });

  it("searches customers without requesting protected name or email fields", async () => {
    graphqlMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            customers: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Customer/11",
                    legacyResourceId: "11",
                  },
                },
              ],
            },
          },
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await searchCustomers("example.myshopify.com", "buyer@example.com");

    const [query] = graphqlMock.mock.calls[0] ?? [];
    expect(query).not.toContain("displayName");
    expect(query).not.toContain("\n                email\n");
    expect(result).toEqual([
      {
        gid: "gid://shopify/Customer/11",
        legacyId: "11",
      },
    ]);
  });
});
