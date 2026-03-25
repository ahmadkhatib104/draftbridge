import db from "../app/db.server";
import { getPlanCatalogEntry, type PaidBillingPlan } from "../app/lib/billing";
import {
  getBillingDiagnostics,
  recordOverageUsageCharge,
  syncBillingStateIfStale,
} from "../app/services/billing.server";
import { unauthenticated } from "../app/shopify.server";

function parseArgs(args: string[]) {
  const parsed: {
    shopDomain: string | null;
    createValidationCharge: boolean;
    description: string;
  } = {
    shopDomain: null,
    createValidationCharge: false,
    description: "DraftBridge billing validation overage",
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if ((value === "--shop" || value === "-s") && args[index + 1]) {
      parsed.shopDomain = args[index + 1]!;
      index += 1;
      continue;
    }

    if (value === "--create-validation-charge") {
      parsed.createValidationCharge = true;
      continue;
    }

    if ((value === "--description" || value === "-d") && args[index + 1]) {
      parsed.description = args[index + 1]!;
      index += 1;
    }
  }

  return parsed;
}

function formatBoolean(value: boolean) {
  return value ? "Yes" : "No";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.shopDomain) {
    console.error(
      "Usage: npm run billing:validate -- --shop draftbridge-qa.myshopify.com [--create-validation-charge] [--description \"...\"]",
    );
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

  const { admin } = await unauthenticated.admin(args.shopDomain);
  const billingState = await syncBillingStateIfStale({
    shopId: shop.id,
    shopDomain: args.shopDomain,
    admin,
    force: true,
  });
  const diagnostics = await getBillingDiagnostics({
    shopId: shop.id,
    billingState,
    admin,
  });

  console.log(`# Billing validation for ${args.shopDomain}`);
  console.log(`- Plan: ${billingState.plan}`);
  console.log(`- Status: ${billingState.status}`);
  console.log(
    `- Active subscription: ${diagnostics.activeSubscription?.name ?? "None"}`,
  );
  console.log(
    `- Usage line item attached: ${formatBoolean(
      diagnostics.activeSubscription?.hasUsageLineItem ?? false,
    )}`,
  );
  console.log(
    `- Included successes: ${diagnostics.includedSuccessCount} | Overage successes: ${diagnostics.overageSuccessCount}`,
  );
  console.log(
    `- Billed overages: ${diagnostics.billedOverageCount} | Pending overages: ${diagnostics.pendingOverageCount}`,
  );

  if (diagnostics.activeSubscription?.usageTerms) {
    console.log(`- Usage terms: ${diagnostics.activeSubscription.usageTerms}`);
  }

  if (!args.createValidationCharge) {
    return;
  }

  if (billingState.plan === "FREE") {
    throw new Error("Cannot create a validation usage charge while the shop is on the Free plan.");
  }

  if (!diagnostics.activeSubscription?.hasUsageLineItem) {
    throw new Error("Active subscription is missing the usage line item.");
  }

  const usageRecordId = await recordOverageUsageCharge({
    shopDomain: args.shopDomain,
    billingPlan: billingState.plan as PaidBillingPlan,
    usageLedgerId: `validation-${Date.now()}`,
    description: args.description,
  });

  if (!usageRecordId) {
    throw new Error("Shopify did not return an AppUsageRecord ID.");
  }

  console.log(`- Validation usage record created: ${usageRecordId}`);
  console.log(
    `- Validation charge amount: ${getPlanCatalogEntry(billingState.plan)?.overagePriceLabel ?? "N/A"}`,
  );
}

await main();
