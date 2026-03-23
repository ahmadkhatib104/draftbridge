# MVP Scope

## Included

- Shopify embedded app
- Merchant-specific forwarding mailbox
- Email body, PDF, CSV, and XLSX ingestion
- Deterministic parsing first
- OpenAI fallback extraction when text quality is weak
- SKU matching against Shopify
- Customer fallback matching against Shopify customers
- Draft-order creation for high-confidence orders
- Internal ops queue for low-confidence orders
- Usage tracking for successful processed POs
- Billing page with four recurring plans

## Explicitly Out Of Scope

- ERP integrations
- EDI
- Merchant-facing exception queue
- Blind fulfillment
- Supplier-side purchase order issuance
- Multi-platform ecommerce support

## Acceptance Gates

- `npm test`, `npm run typecheck`, and `npm run lint` all pass
- Sample CSV and text-body parsing are covered by tests
- Draft-order creation path is implemented behind a live Shopify session
- Inbound webhook persists messages and documents before processing
