# DraftBridge

Embedded Shopify app for wholesale merchants who still receive inbound purchase orders by email, PDF, CSV, or XLSX and want validated draft orders created inside Shopify.

## Product Promise

- Forward wholesale POs to a merchant-specific mailbox.
- Parse email body text, PDF attachments, CSV, and XLSX.
- Match SKUs against the Shopify catalog.
- Validate quantity and price before draft-order creation.
- Auto-create draft orders only when confidence is high.
- Send lower-confidence cases to an internal ops queue.

## Current Stack

- Shopify embedded app using the React Router template
- TypeScript
- Prisma
- PostgreSQL
- Cloudflare Email Routing plus an Email Worker
- Cloudflare R2 document storage fallback
- OpenAI fallback extraction for weak document text

## Local Setup

1. Install dependencies:

```sh
npm install
```

2. Copy the env template and fill in the required values:

```sh
cp .env.example .env
```

3. Generate Prisma client:

```sh
npm run db:generate
```

4. Apply the initial migration when a PostgreSQL database is available:

```sh
npm run db:deploy
```

5. Seed demo data:

```sh
npm run db:seed
```

6. Link the repo to a Shopify app config after logging into Shopify CLI:

```sh
npm run config:link
```

7. Start local development:

```sh
npm run dev
```

## Validation

- `npm test`
- `npm run typecheck`
- `npm run lint`
- `npm run report:drift -- --shop draftbridge-qa.myshopify.com`
- `npm run billing:validate -- --shop draftbridge-qa.myshopify.com`
- `npm run billing:validate -- --shop draftbridge-qa.myshopify.com --create-validation-charge`

## Important Human Checkpoints

- Shopify Partner app creation and CLI login
- Development store install
- Render deploy and callback URL update
- Cloudflare Email Routing domain setup and Worker deploy
- Render, Neon, and Cloudflare R2 accounts
- Production `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `DATABASE_URL`

## Key Routes

- `/app`
- `/app/onboarding`
- `/app/orders`
- `/app/billing`
- `/app/reporting`
- `/app/settings`
- `/webhooks/inbound-email`
- `/ops/cases`

## Docs

- [Architecture](./docs/architecture.md)
- [Environment setup](./docs/environment-setup.md)
- [Human actions](./docs/human-actions.md)
- [MVP scope](./docs/mvp.md)
- [TODO](./docs/todo.md)
- [Deployment runbook](./docs/deployment-runbook.md)
