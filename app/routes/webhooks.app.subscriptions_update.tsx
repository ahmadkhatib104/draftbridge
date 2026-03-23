import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncBillingStateIfStale } from "../services/billing.server";
import { createAuditEvent } from "../services/audit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, session, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const localShop = await db.shop.findUnique({
    where: { shopDomain: shop },
    select: { id: true },
  });

  if (!localShop) {
    return new Response();
  }

  if (session && admin) {
    await syncBillingStateIfStale({
      shopId: localShop.id,
      shopDomain: shop,
      admin,
      force: true,
    });
  }

  await createAuditEvent({
    shopId: localShop.id,
    entityType: "BILLING",
    entityId: localShop.id,
    actorType: "WEBHOOK",
    action: "APP_SUBSCRIPTIONS_UPDATED",
    summary: "Shopify app billing status changed.",
    metadata: payload as never,
  });

  return new Response();
};
