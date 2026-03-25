import db from "../app/db.server";
import { purgeShopDocumentPrefix } from "../app/services/storage.server";

const RETENTION_DAYS = Number(process.env.PERSONAL_DATA_RETENTION_DAYS ?? "90");

async function main() {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error("PERSONAL_DATA_RETENTION_DAYS must be a positive integer.");
  }

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const shops = await db.shop.findMany({
    where: {
      uninstalledAt: {
        lte: cutoff,
      },
    },
    select: {
      id: true,
      shopDomain: true,
      uninstalledAt: true,
    },
  });

  for (const shop of shops) {
    await purgeShopDocumentPrefix(shop.id);
    await db.session.deleteMany({
      where: {
        shop: shop.shopDomain,
      },
    });
    await db.shop.delete({
      where: {
        id: shop.id,
      },
    });
  }

  console.log(
    JSON.stringify(
      {
        retentionDays: RETENTION_DAYS,
        cutoff: cutoff.toISOString(),
        deletedShops: shops.length,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
