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

## Next Instrumentation Work

- Add a straight-through processing rate report.
- Add a low-confidence reason breakdown by validation code.
- Add a usage-by-period summary for included vs overage volume.
