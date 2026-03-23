# TODO

## Immediate

- Complete Shopify protected customer data request and approval so the app can access `Customer` and `DraftOrder` objects in live API calls.
- Point Cloudflare Email Routing at the deployed worker after purchasing and adding the inbound domain to Cloudflare.
- Create a real hosted app deployment target. Render is still pending because this workspace is not linked to a deployable Git remote.
- Add a true scanned-PDF/image OCR path before broader pilot traffic.
- Add internal ops-case actions for correcting customer and variant matches from the browser.
- Add usage overage charging once Shopify billing approval and production subscriptions are live.
- Add authenticated merchant-facing clarification requests instead of relying only on internal ops.
- Add richer instrumentation for straight-through processing rate and parse drift.

## After First Pilot

- Add sender-specific spreadsheet column memory editing in the UI.
- Add manual customer and company-location alias management.
- Add retryable job queue instead of synchronous webhook processing.
- Add support playbooks and merchant-facing App Store assets.
