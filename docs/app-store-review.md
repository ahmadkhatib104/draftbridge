# App Store Review Notes

## Reviewer Summary

DraftBridge is a Shopify embedded app that converts inbound wholesale purchase orders into validated draft orders.

## Reviewer Walkthrough

1. Install the app.
2. Open `/app/onboarding` and copy the forwarding address.
3. Send a sample PO email to the configured inbox.
4. Open `/app/orders` and inspect the processed order.
5. Open `/app/billing` and confirm the recurring plans.

## Important Constraints

- DraftBridge never fulfills orders automatically.
- Lower-confidence orders stay in ops review instead of becoming draft orders automatically.
