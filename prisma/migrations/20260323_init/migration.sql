-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('INSTALL_STARTED', 'MAILBOX_CREATED', 'SAMPLE_RECEIVED', 'READY');

-- CreateEnum
CREATE TYPE "MailboxProvider" AS ENUM ('CLOUDFLARE_EMAIL_ROUTING');

-- CreateEnum
CREATE TYPE "InboundMessageStatus" AS ENUM ('RECEIVED', 'PARSED', 'AUTO_DRAFTED', 'OPS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceDocumentKind" AS ENUM ('EMAIL_BODY', 'PDF', 'CSV', 'XLSX', 'IMAGE', 'TEXT');

-- CreateEnum
CREATE TYPE "ParseStatus" AS ENUM ('PENDING', 'PARSED', 'FALLBACK_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('RECEIVED', 'EXTRACTED', 'VALIDATED', 'AUTO_DRAFTED', 'OPS_REVIEW', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "LineValidationStatus" AS ENUM ('PENDING', 'MATCHED', 'REVIEW_REQUIRED', 'INVALID');

-- CreateEnum
CREATE TYPE "CatalogAliasType" AS ENUM ('CUSTOMER_SKU', 'DESCRIPTION');

-- CreateEnum
CREATE TYPE "CustomerAliasType" AS ENUM ('SENDER_EMAIL', 'COMPANY_NAME', 'CONTACT_EMAIL', 'SHIP_TO_NAME');

-- CreateEnum
CREATE TYPE "ValidationSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "DraftOrderStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED');

-- CreateEnum
CREATE TYPE "UsageEventType" AS ENUM ('INCLUDED_SUCCESS', 'OVERAGE_SUCCESS');

-- CreateEnum
CREATE TYPE "OpsCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_MERCHANT', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('SYSTEM', 'USER', 'WEBHOOK', 'OPS');

-- CreateEnum
CREATE TYPE "AuditEntityType" AS ENUM ('SHOP', 'MAILBOX', 'MESSAGE', 'DOCUMENT', 'PURCHASE_ORDER', 'LINE_ITEM', 'BILLING', 'DRAFT_ORDER', 'OPS_CASE');

-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('INACTIVE', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyShopId" TEXT,
    "name" TEXT,
    "email" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Phoenix',
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'INSTALL_STARTED',
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyUserId" TEXT,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" "MailboxProvider" NOT NULL DEFAULT 'CLOUDFLARE_EMAIL_ROUTING',
    "routingKey" TEXT NOT NULL,
    "forwardingAddress" TEXT NOT NULL,
    "inboundDomain" TEXT NOT NULL,
    "senderHint" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SenderProfile" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "customerName" TEXT,
    "companyName" TEXT,
    "contactEmail" TEXT,
    "defaultCurrency" TEXT,
    "spreadsheetHints" JSONB,
    "sampleSubject" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderName" TEXT,
    "subject" TEXT,
    "rawTextBody" TEXT,
    "rawHtmlBody" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" "InboundMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastProcessedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "kind" "SourceDocumentKind" NOT NULL,
    "filename" TEXT,
    "contentType" TEXT,
    "contentSize" INTEGER,
    "contentHash" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL DEFAULT 'database',
    "storageKey" TEXT,
    "contentBase64" TEXT,
    "extractedText" TEXT,
    "pageCount" INTEGER,
    "parseStatus" "ParseStatus" NOT NULL DEFAULT 'PENDING',
    "parseError" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "mailboxId" TEXT,
    "senderProfileId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'RECEIVED',
    "poNumber" TEXT,
    "supplierReference" TEXT,
    "customerName" TEXT,
    "companyName" TEXT,
    "contactEmail" TEXT,
    "currency" TEXT,
    "orderDate" TIMESTAMP(3),
    "shipToName" TEXT,
    "shipToAddress" TEXT,
    "billToName" TEXT,
    "billToAddress" TEXT,
    "notes" TEXT,
    "extractedConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finalConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "clarificationNeeded" BOOLEAN NOT NULL DEFAULT false,
    "duplicateOfId" TEXT,
    "matchedCustomerId" TEXT,
    "matchedCompanyId" TEXT,
    "matchedCompanyLocationId" TEXT,
    "billableSuccessAt" TIMESTAMP(3),
    "lastRetriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "customerSku" TEXT,
    "merchantSku" TEXT,
    "description" TEXT,
    "quantity" INTEGER,
    "unitPrice" DECIMAL(10,2),
    "uom" TEXT,
    "extractedConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "matchConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "matchedVariantId" TEXT,
    "matchedSku" TEXT,
    "matchedTitle" TEXT,
    "validationStatus" "LineValidationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogAlias" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "senderProfileId" TEXT,
    "aliasType" "CatalogAliasType" NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAlias" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "aliasType" "CustomerAliasType" NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "customerId" TEXT,
    "companyId" TEXT,
    "companyLocationId" TEXT,
    "contactEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationIssue" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "lineItemId" TEXT,
    "severity" "ValidationSeverity" NOT NULL DEFAULT 'ERROR',
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftOrderSync" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "status" "DraftOrderStatus" NOT NULL DEFAULT 'PENDING',
    "shopifyDraftOrderId" TEXT,
    "shopifyDraftOrderName" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftOrderSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "eventType" "UsageEventType" NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingState" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "plan" "BillingPlan" NOT NULL DEFAULT 'FREE',
    "status" "BillingStatus" NOT NULL DEFAULT 'INACTIVE',
    "shopifySubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "includedUsageLimit" INTEGER NOT NULL DEFAULT 0,
    "billableUsageCount" INTEGER NOT NULL DEFAULT 0,
    "overageUsageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsCase" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "status" "OpsCaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "summary" TEXT NOT NULL,
    "resolutionNotes" TEXT,
    "clarificationRequestedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "opsCaseId" TEXT,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorUserId" TEXT,
    "entityType" "AuditEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyShopId_key" ON "Shop"("shopifyShopId");

-- CreateIndex
CREATE INDEX "User_shopId_idx" ON "User"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "User_shopId_email_key" ON "User"("shopId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_routingKey_key" ON "Mailbox"("routingKey");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_forwardingAddress_key" ON "Mailbox"("forwardingAddress");

-- CreateIndex
CREATE INDEX "Mailbox_shopId_idx" ON "Mailbox"("shopId");

-- CreateIndex
CREATE INDEX "SenderProfile_shopId_senderDomain_idx" ON "SenderProfile"("shopId", "senderDomain");

-- CreateIndex
CREATE UNIQUE INDEX "SenderProfile_shopId_senderEmail_key" ON "SenderProfile"("shopId", "senderEmail");

-- CreateIndex
CREATE INDEX "InboundMessage_shopId_status_receivedAt_idx" ON "InboundMessage"("shopId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundMessage_mailboxId_receivedAt_idx" ON "InboundMessage"("mailboxId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_shopId_dedupeHash_key" ON "InboundMessage"("shopId", "dedupeHash");

-- CreateIndex
CREATE INDEX "SourceDocument_shopId_contentHash_idx" ON "SourceDocument"("shopId", "contentHash");

-- CreateIndex
CREATE INDEX "SourceDocument_inboundMessageId_sequence_idx" ON "SourceDocument"("inboundMessageId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_sourceDocumentId_key" ON "PurchaseOrder"("sourceDocumentId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shopId_status_createdAt_idx" ON "PurchaseOrder"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shopId_poNumber_idx" ON "PurchaseOrder"("shopId", "poNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrder_senderProfileId_createdAt_idx" ON "PurchaseOrder"("senderProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_lineNumber_idx" ON "PurchaseOrderLine"("purchaseOrderId", "lineNumber");

-- CreateIndex
CREATE INDEX "CatalogAlias_shopId_aliasType_normalizedValue_idx" ON "CatalogAlias"("shopId", "aliasType", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogAlias_shopId_aliasType_normalizedValue_senderProfile_key" ON "CatalogAlias"("shopId", "aliasType", "normalizedValue", "senderProfileId");

-- CreateIndex
CREATE INDEX "CustomerAlias_shopId_aliasType_normalizedValue_idx" ON "CustomerAlias"("shopId", "aliasType", "normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAlias_shopId_aliasType_normalizedValue_key" ON "CustomerAlias"("shopId", "aliasType", "normalizedValue");

-- CreateIndex
CREATE INDEX "ValidationIssue_purchaseOrderId_blocking_idx" ON "ValidationIssue"("purchaseOrderId", "blocking");

-- CreateIndex
CREATE INDEX "ValidationIssue_shopId_severity_createdAt_idx" ON "ValidationIssue"("shopId", "severity", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DraftOrderSync_purchaseOrderId_key" ON "DraftOrderSync"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "DraftOrderSync_shopId_status_updatedAt_idx" ON "DraftOrderSync"("shopId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "UsageLedger_shopId_eventType_occurredAt_idx" ON "UsageLedger"("shopId", "eventType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingState_shopId_key" ON "BillingState"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "OpsCase_purchaseOrderId_key" ON "OpsCase"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "OpsCase_shopId_status_createdAt_idx" ON "OpsCase"("shopId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_shopId_createdAt_idx" ON "AuditEvent"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SenderProfile" ADD CONSTRAINT "SenderProfile_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMessage" ADD CONSTRAINT "InboundMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_senderProfileId_fkey" FOREIGN KEY ("senderProfileId") REFERENCES "SenderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogAlias" ADD CONSTRAINT "CatalogAlias_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogAlias" ADD CONSTRAINT "CatalogAlias_senderProfileId_fkey" FOREIGN KEY ("senderProfileId") REFERENCES "SenderProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAlias" ADD CONSTRAINT "CustomerAlias_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationIssue" ADD CONSTRAINT "ValidationIssue_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftOrderSync" ADD CONSTRAINT "DraftOrderSync_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftOrderSync" ADD CONSTRAINT "DraftOrderSync_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingState" ADD CONSTRAINT "BillingState_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsCase" ADD CONSTRAINT "OpsCase_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsCase" ADD CONSTRAINT "OpsCase_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_opsCaseId_fkey" FOREIGN KEY ("opsCaseId") REFERENCES "OpsCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
