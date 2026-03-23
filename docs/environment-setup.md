# Environment Setup

## Required Accounts

- Shopify Partner account
- Shopify development store
- Render account
- Neon Postgres account
- Cloudflare account for R2 and Email Routing
- OpenAI API key

## Required Env Vars

- `DATABASE_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SHOPIFY_APP_HANDLE`
- `SCOPES`
- `EMAIL_ROUTING_DOMAIN` (the exact inbound domain, for example `draftbridgehq.com`)
- `EMAIL_INGEST_SHARED_SECRET`
- `OPENAI_API_KEY`
- `OPENAI_PRIMARY_MODEL`
- `OPENAI_RETRY_MODEL`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `OPS_DASHBOARD_TOKEN`

## Minimal Local Bring-Up

1. Fill `.env`.
2. Run `npm install`.
3. Run `npm run db:generate`.
4. Run `npm run db:deploy` against a live Postgres database.
5. Run `npm run db:seed`.
6. Link the Shopify app and install it on a dev store.
7. Deploy the Cloudflare Email Worker and set its `INGEST_ENDPOINT` to:

```text
https://your-app-host.example.com/webhooks/inbound-email
```

8. Set the same `EMAIL_INGEST_SHARED_SECRET` value in the app env and the Worker secret store.

## Notes

- If `R2_*` vars are missing, DraftBridge falls back to storing source document content in the database.
- If `OPENAI_API_KEY` is missing, DraftBridge uses deterministic extraction only and routes weak documents to ops review.
- DraftBridge does not expose email-forwarding claims publicly until the Cloudflare routing domain is purchased, verified, and routed to the Worker.
