# Architecture

## Stack

- Shopify embedded app
- Shopify React Router app template
- Prisma with PostgreSQL
- Provider-neutral inbound email webhook
- Cloudflare Email Routing Worker
- Cloudflare R2 for original document storage when configured
- OpenAI for fallback extraction when deterministic parsing is weak

## Core Flow

1. Merchant installs the app and receives a unique forwarding address.
2. Cloudflare Email Routing passes inbound mail to the Email Worker.
3. The Worker normalizes the message and posts it to `/webhooks/inbound-email`.
4. DraftBridge stores the inbound message, sender profile, and source documents.
5. Deterministic parsing extracts text from email bodies, CSV, XLSX, and text-based PDFs.
6. A structured purchase-order candidate is extracted from the parsed content.
7. Shopify catalog and customer matching run against live Admin API data plus learned alias memory.
8. Validated, high-confidence orders create Shopify draft orders through the Admin API.
9. Blocking or uncertain cases become `OpsCase` rows for internal review while staying visible in the merchant exception queue.
10. Operational reporting rolls up funnel, drift, queue, and billing-diagnostic metrics for `/app/reporting` and terminal drift reports.

## Key Models

- `Shop`
- `Mailbox`
- `SenderProfile`
- `InboundMessage`
- `SourceDocument`
- `PurchaseOrder`
- `PurchaseOrderLine`
- `CatalogAlias`
- `CustomerAlias`
- `ValidationIssue`
- `DraftOrderSync`
- `UsageLedger`
- `BillingState`
- `OpsCase`
- `AuditEvent`

## Design Boundaries

- Shopify only in v1
- Draft orders only, never blind fulfillment
- Internal ops queue remains the support workflow, but merchants can still see unresolved exceptions and add clarification
- Merchant-facing workflow stays narrow: onboarding, order history, billing, settings
- B2B entity support is alias-memory assisted; customer fallback stays available when full B2B context is not known
