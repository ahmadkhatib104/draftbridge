import {
  AuditActorType,
  AuditEntityType,
  BillingPlan,
  BillingStatus,
  DraftOrderStatus,
  InboundMessageStatus,
  LineValidationStatus,
  MailboxProvider,
  OnboardingStatus,
  ParseStatus,
  PurchaseOrderStatus,
  SourceDocumentKind,
  UsageEventType,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const shop = await prisma.shop.upsert({
    where: { shopDomain: "demo-wholesale.myshopify.com" },
    update: {},
    create: {
      shopDomain: "demo-wholesale.myshopify.com",
      name: "Demo Wholesale Co.",
      email: "ops@demowholesale.example",
      onboardingStatus: OnboardingStatus.READY,
      installedAt: new Date(),
    },
  });

  const mailbox = await prisma.mailbox.upsert({
    where: { routingKey: "demo-wholesale" },
    update: {},
    create: {
      shopId: shop.id,
      provider: MailboxProvider.CLOUDFLARE_EMAIL_ROUTING,
      routingKey: "demo-wholesale",
      forwardingAddress: "demo-wholesale@mail.example.com",
      inboundDomain: "mail.example.com",
      senderHint: "Forward retailer POs here",
    },
  });

  await prisma.billingState.upsert({
    where: { shopId: shop.id },
    update: {},
    create: {
      shopId: shop.id,
      plan: BillingPlan.GROWTH,
      status: BillingStatus.TRIAL,
      includedUsageLimit: 100,
    },
  });

  const inboundMessage = await prisma.inboundMessage.create({
    data: {
      shopId: shop.id,
      mailboxId: mailbox.id,
      dedupeHash: "demo-message-1",
      externalMessageId: "demo-message-1",
      senderEmail: "buyer@bigbox.example",
      senderName: "Big Box Retail",
      subject: "PO 10052",
      rawTextBody:
        "Please process PO 10052. SKU DB-001 qty 12 unit price 18.00.",
      receivedAt: new Date(),
      status: InboundMessageStatus.AUTO_DRAFTED,
    },
  });

  const document = await prisma.sourceDocument.create({
    data: {
      shopId: shop.id,
      inboundMessageId: inboundMessage.id,
      kind: SourceDocumentKind.EMAIL_BODY,
      filename: "email-body.txt",
      contentHash: "demo-document-1",
      extractedText:
        "PO 10052\nCustomer: Big Box Retail\nSKU DB-001 Qty 12 Price 18.00",
      parseStatus: ParseStatus.PARSED,
    },
  });

  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      shopId: shop.id,
      inboundMessageId: inboundMessage.id,
      sourceDocumentId: document.id,
      mailboxId: mailbox.id,
      poNumber: "10052",
      companyName: "Big Box Retail",
      customerName: "Big Box Retail",
      contactEmail: "buyer@bigbox.example",
      currency: "USD",
      shipToName: "Big Box Receiving",
      shipToAddress: "100 Market St, Phoenix AZ 85004",
      status: PurchaseOrderStatus.AUTO_DRAFTED,
      extractedConfidence: 0.98,
      finalConfidence: 0.98,
      billableSuccessAt: new Date(),
      lineItems: {
        create: {
          lineNumber: 1,
          customerSku: "DB-001",
          merchantSku: "DB-001",
          description: "DraftBridge Sample Product",
          quantity: 12,
          unitPrice: 18,
          uom: "each",
          extractedConfidence: 0.99,
          matchConfidence: 0.99,
          matchedVariantId: "gid://shopify/ProductVariant/1",
          matchedSku: "DB-001",
          matchedTitle: "DraftBridge Sample Product",
          validationStatus: LineValidationStatus.MATCHED,
        },
      },
      draftOrderSync: {
        create: {
          shop: {
            connect: { id: shop.id },
          },
          status: DraftOrderStatus.CREATED,
          shopifyDraftOrderId: "gid://shopify/DraftOrder/1",
          shopifyDraftOrderName: "#D1",
        },
      },
      auditEvents: {
        create: {
          shop: {
            connect: { id: shop.id },
          },
          actorType: AuditActorType.SYSTEM,
          entityType: AuditEntityType.PURCHASE_ORDER,
          entityId: "seed-po",
          action: "SEED_PURCHASE_ORDER_CREATED",
          summary: "Seeded a successful demo purchase order.",
        },
      },
    },
  });

  await prisma.usageLedger.create({
    data: {
      shopId: shop.id,
      purchaseOrderId: purchaseOrder.id,
      eventType: UsageEventType.INCLUDED_SUCCESS,
    },
  });
}

main()
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
