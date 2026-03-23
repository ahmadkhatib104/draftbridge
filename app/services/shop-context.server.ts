import { authenticate } from "../shopify.server";
import { ensureShopRecord } from "./shop.server";

export async function requireShopContext(request: Request) {
  const { admin, billing, session } = await authenticate.admin(request);
  const shop = await ensureShopRecord(session.shop);

  return { admin, billing, session, shop };
}
