import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAuditEvent } from "../services/audit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} compliance webhook for ${shop}`);

  const localShop = await db.shop.findUnique({
    where: { shopDomain: shop },
    select: { id: true },
  });

  if (!localShop) {
    return new Response();
  }

  if (topic === "shop/redact") {
    await db.shop.delete({
      where: { id: localShop.id },
    });
    await db.session.deleteMany({
      where: { shop },
    });

    return new Response();
  }

  if (topic === "customers/redact") {
    const email = (payload as { customer?: { email?: string | null } }).customer?.email?.toLowerCase();

    if (email) {
      await db.purchaseOrder.updateMany({
        where: {
          shopId: localShop.id,
          contactEmail: email,
        },
        data: {
          contactEmail: null,
        },
      });
    }
  }

  await createAuditEvent({
    shopId: localShop.id,
    entityType: "SHOP",
    entityId: localShop.id,
    actorType: "WEBHOOK",
    action: topic.toUpperCase().replace(/[/.]/g, "_"),
    summary: `Processed Shopify compliance webhook ${topic}.`,
    metadata: payload as never,
  });

  return new Response();
};
