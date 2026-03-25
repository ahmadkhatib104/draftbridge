import db from "../app/db.server";
import {
  formatOperationalReportMarkdown,
  getOperationalReport,
} from "../app/services/reporting.server";

function parseArgs(args: string[]) {
  const parsed: {
    shopDomain: string | null;
    windowDays: number;
  } = {
    shopDomain: null,
    windowDays: 7,
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if ((value === "--shop" || value === "-s") && args[index + 1]) {
      parsed.shopDomain = args[index + 1]!;
      index += 1;
      continue;
    }

    if ((value === "--window-days" || value === "-w") && args[index + 1]) {
      parsed.windowDays = Number(args[index + 1] ?? 7) || 7;
      index += 1;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.shopDomain) {
    console.error("Usage: npm run report:drift -- --shop draftbridge-qa.myshopify.com [--window-days 7]");
    process.exitCode = 1;
    return;
  }

  const shop = await db.shop.findUnique({
    where: { shopDomain: args.shopDomain },
    select: { id: true },
  });

  if (!shop) {
    console.error(`Shop not found for ${args.shopDomain}.`);
    process.exitCode = 1;
    return;
  }

  const report = await getOperationalReport({
    shopId: shop.id,
    windowDays: args.windowDays,
  });

  console.log(formatOperationalReportMarkdown(report));
}

await main();
