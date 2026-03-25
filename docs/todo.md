# TODO

## Immediate

- Complete Shopify protected customer data request and approval so the app can access `Customer` and `DraftOrder` objects in live API calls.
- Reinstall or upgrade existing test subscriptions so Shopify usage-line-item billing is attached for overage charging.
- Add richer instrumentation for straight-through processing rate and parse drift.

## After First Pilot

- Add sender-specific spreadsheet column memory editing in the UI.
- Add manual customer and company-location alias management.
- Replace synchronous webhook processing with a background job queue once pilot traffic exceeds the current straight-through throughput envelope.
- Add support playbooks and merchant-facing App Store assets.
