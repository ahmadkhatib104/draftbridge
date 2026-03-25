# Deployment Runbook

## Render

1. Create a Render web service from this repo.
2. Use `render.yaml` as the baseline.
3. Set:
   - `DATABASE_URL`
   - `SHOPIFY_API_KEY`
   - `SHOPIFY_API_SECRET`
   - `SHOPIFY_APP_URL`
   - `EMAIL_ROUTING_DOMAIN`
   - `EMAIL_INGEST_SHARED_SECRET`
   - `OPENAI_API_KEY`
   - `OPENAI_PRIMARY_MODEL`
   - `OPENAI_OCR_MODEL`
   - `OPENAI_RETRY_MODEL`
   - `R2_ACCOUNT_ID`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
   - `R2_BUCKET`
   - `R2_PUBLIC_BASE_URL`
   - `OPS_DASHBOARD_TOKEN`

## Neon

1. Create a Postgres database.
2. Copy the pooled connection string into `DATABASE_URL`.
3. Run `npm run db:deploy`.

## Shopify

1. Update `shopify.app.toml` with the real `client_id` and public URL.
2. Run `npm run config:link`.
3. Install the app on a dev or pilot store.
4. Reaccept the test subscription from `/app/billing` whenever the recurring-plus-usage billing model changes.
5. Run `npm run billing:validate -- --shop your-store.myshopify.com`.
6. On a QA or dev store, run `npm run billing:validate -- --shop your-store.myshopify.com --create-validation-charge` once to confirm Shopify accepts usage charges for the active subscription.

## Cloudflare Email Routing

1. Purchase or delegate the inbound mail domain used by `EMAIL_ROUTING_DOMAIN`.
2. Enable Cloudflare Email Routing and route the DraftBridge aliases to the Worker in `workers/email-ingest/`.
3. Set the Worker `INGEST_ENDPOINT` to `https://your-app-host.example.com/webhooks/inbound-email`.
4. Set the Worker secret and Render `EMAIL_INGEST_SHARED_SECRET` to the same value.
5. Send a sample email with PDF and spreadsheet attachments.
6. Run `npm run report:drift -- --shop your-store.myshopify.com` and compare the results against `/app/reporting`.

Recommended baseline:
- `OPENAI_PRIMARY_MODEL=gpt-5.4-mini`
- `OPENAI_OCR_MODEL=gpt-5.4`
- `OPENAI_RETRY_MODEL=gpt-5.4`
