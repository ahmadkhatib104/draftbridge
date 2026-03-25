# Funnel Instrumentation

## Core Stages

- Install
- Mailbox created
- First sample PO received
- First successful draft order
- Billing started
- Paid subscription live

## Current Source Of Truth

- `Shop`
- `Mailbox`
- `InboundMessage`
- `PurchaseOrder`
- `DraftOrderSync`
- `BillingState`
- `UsageLedger`
- `AuditEvent`

## Implemented Reporting

- `/app/reporting` shows:
  - current vs prior 7-day order volume
  - straight-through, review, and failure rates
  - top validation-issue codes
  - sender and document-type drift alerts
  - queue-aging buckets
  - billing diagnostics, including whether the active Shopify subscription has a usage line item attached
- `npm run report:drift -- --shop draftbridge-qa.myshopify.com` prints the same operational drift summary as Markdown for terminal or automation use.
- `npm run billing:validate -- --shop draftbridge-qa.myshopify.com` prints the live billing diagnostics for a store.
- `npm run billing:validate -- --shop draftbridge-qa.myshopify.com --create-validation-charge` creates a test usage record against the active subscription so overage billing can be validated after pricing changes.

## Current Metrics

- Straight-through processing rate
- Review rate
- Failure rate
- Average extracted confidence
- Average final confidence
- Validation-code breakdown
- Parse-status breakdown by primary document type
- Sender drift vs prior period
- Document-type drift vs prior period
- Included vs overage usage counts
- Billed vs pending overage counts

## Next Enhancements

- Add sender-specific spreadsheet column-memory editing to the UI.
- Persist alert acknowledgements for recurring drift patterns.
- Add a longer-range 30-day trend view once pilot traffic is large enough to make it meaningful.
