# Commercial Readiness

## Current

- Embedded app shell is in place.
- Cloudflare Email Routing intake and inbound webhook handling are implemented.
- Deterministic parsing, OCR fallback, validation, and draft-order creation paths exist.
- Internal ops queue and merchant clarification flows exist.
- App Store listing assets and review copy are in place.
- Reporting and drift diagnostics are available in `/app/reporting` and `npm run report:drift`.
- Billing diagnostics are available in `/app/billing` and `npm run billing:validate`.
- QA billing validation is complete as of March 25, 2026:
  - the QA store is on `DraftBridge Growth`
  - `/app/billing` reports `Usage line item attached: Yes`
  - Shopify accepted a live validation usage record on the active subscription

## Remaining External Gates

- Shopify protected-customer-data review outcome
- First non-dev pilot validation before charging a real merchant account
