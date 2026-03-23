import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createAuditEvent } from "../services/audit.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  const localShop = await db.shop.findUnique({
    where: { shopDomain: shop },
    select: { id: true },
  });

  if (localShop) {
    await db.shop.update({
      where: { id: localShop.id },
      data: {
        uninstalledAt: new Date(),
      },
    });

    await createAuditEvent({
      shopId: localShop.id,
      entityType: "SHOP",
      entityId: localShop.id,
      actorType: "WEBHOOK",
      action: "APP_UNINSTALLED",
      summary: "Shopify sent the app/uninstalled webhook.",
    });
  }

  return new Response();
};
