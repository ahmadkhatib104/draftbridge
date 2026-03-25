import { authenticate } from "../shopify.server";
import { ensureShopRecord } from "./shop.server";

export async function requireShopContext(request: Request) {
  const { admin, billing, session } = await authenticate.admin(request);
  const associatedUser = session.onlineAccessInfo?.associated_user;
  const shop = await ensureShopRecord(
    session.shop,
    associatedUser?.email,
    associatedUser?.id === undefined ? undefined : String(associatedUser.id),
    {
      firstName: associatedUser?.first_name,
      lastName: associatedUser?.last_name,
    },
  );

  return { admin, billing, session, shop };
}
