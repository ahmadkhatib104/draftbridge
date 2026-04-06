import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { createAuditEvent } from "../services/audit.server";

function getDraftOrderGid(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    id?: string | number | null;
    admin_graphql_api_id?: string | null;
  };

  if (typeof candidate.admin_graphql_api_id === "string" && candidate.admin_graphql_api_id) {
    return candidate.admin_graphql_api_id;
  }

  if (typeof candidate.id === "string" && candidate.id) {
    return `gid://shopify/DraftOrder/${candidate.id}`;
  }

  if (typeof candidate.id === "number") {
    return `gid://shopify/DraftOrder/${candidate.id}`;
  }

  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const localShop = await db.shop.findUnique({
    where: { shopDomain: shop },
    select: { id: true },
  });

  if (!localShop) {
    return new Response();
  }

  const draftOrderGid = getDraftOrderGid(payload);

  if (!draftOrderGid) {
    return new Response();
  }

  const affectedSyncs = await db.draftOrderSync.findMany({
    where: {
      shopId: localShop.id,
      shopifyDraftOrderId: draftOrderGid,
    },
    select: {
      purchaseOrderId: true,
      shopifyDraftOrderName: true,
    },
  });

  if (affectedSyncs.length === 0) {
    return new Response();
  }

  const purchaseOrderIds = affectedSyncs.map((sync) => sync.purchaseOrderId);

  await db.$transaction([
    db.draftOrderSync.updateMany({
      where: {
        shopId: localShop.id,
        shopifyDraftOrderId: draftOrderGid,
      },
      data: {
        status: "FAILED",
        shopifyDraftOrderId: null,
        shopifyDraftOrderName: null,
        errorMessage: "Draft order was deleted in Shopify.",
      },
    }),
    db.purchaseOrder.updateMany({
      where: {
        shopId: localShop.id,
        id: { in: purchaseOrderIds },
      },
      data: {
        status: "FAILED",
      },
    }),
  ]);

  for (const sync of affectedSyncs) {
    await createAuditEvent({
      shopId: localShop.id,
      entityType: "DRAFT_ORDER",
      entityId: draftOrderGid,
      purchaseOrderId: sync.purchaseOrderId,
      actorType: "WEBHOOK",
      action: "DRAFT_ORDER_DELETED",
      summary: `Shopify draft order ${sync.shopifyDraftOrderName ?? draftOrderGid} was deleted in Shopify.`,
      metadata: payload as never,
    });
  }

  return new Response();
};
