# Human Actions

## Required Before Live Traffic

1. Create or link the Shopify Partner app record.
2. Log into Shopify CLI and run `npm run config:link`.
3. Create a development store and install the app.
4. Purchase and verify the Cloudflare email-routing domain.
5. Create the Neon database and set `DATABASE_URL`.
6. Create the Render web service and set production env vars.
7. Create the Cloudflare R2 bucket and credentials.
8. Deploy the Email Worker and bind it to the routing addresses.
9. Rotate and store the OpenAI API key and primary/retry model names.

## Required Before First Paid Pilot

1. Verify billing starts and cancels correctly from `/app/billing`.
2. Verify one sample email body, one PDF, and one spreadsheet flow end to end.
3. Confirm draft orders appear in the dev store with the correct line items.
4. Confirm the internal ops queue is reachable through `/ops/cases`.
5. Confirm `SHOPIFY_APP_URL`, `EMAIL_INGEST_SHARED_SECRET`, and `OPS_DASHBOARD_TOKEN` are set in production.

## Ongoing

- Monitor inbound email failures and webhook errors.
- Review open ops cases daily.
- Review parse drift weekly.
- Review successful PO counts vs included plan limits weekly.
