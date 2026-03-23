# DraftBridge Email Ingest Worker

Cloudflare Email Worker that receives routed wholesale PO emails, normalizes them into DraftBridge's provider-neutral webhook contract, and posts them to the app.

## Setup

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Install dependencies:

```sh
npm install
```

3. Run locally:

```sh
npm run dev
```

4. Deploy:

```sh
npm run deploy
```

## Required Secrets

- `INGEST_ENDPOINT`
- `EMAIL_INGEST_SHARED_SECRET`

Use the same `EMAIL_INGEST_SHARED_SECRET` value here and in the Render app service.
