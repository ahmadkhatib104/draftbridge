# Outbound Playbook

## Best First Targets

- Shopify merchants already doing wholesale (look for a Wholesale or Trade page)
- Teams still receiving POs by email or spreadsheet
- Operators re-keying orders manually into Shopify
- Stores without heavy ERP or EDI workflows
- Revenue range $1M–$15M with a small ops team (5–30 employees)
- Verticals: food/beverage, beauty, apparel, home goods, supplements, pet

## Qualification

Use [public-audit-checklist.md](outbound-assets/public-audit-checklist.md) to
qualify each target before sending cold email. Every target must have a visible
wholesale channel on their Shopify store.

## Execution Tooling

Use the repo research CLI to build the first target list:

```bash
npm run outbound:research -- \
  --query '"wholesale" "beauty" "trade account"' \
  --query '"wholesale" "snacks" "retailers"' \
  --query '"stockists" "shopify"' \
  --output tmp/outbound-targets.csv
```

You can also start from a hand-built seed file:

```bash
npm run outbound:research -- \
  --input tmp/seed-domains.txt \
  --output tmp/outbound-targets.csv
```

The CSV includes company name, detected wholesale page, contact email, score,
verdict, and the reasons behind the score so you can review the top 50 quickly.
Avoid generic `"shopify"`-only queries as your primary source; they surface too
many vendors, agencies, and app ecosystem sites. Start with vertical-specific
queries, then review the scored CSV manually.

## Outbound Templates

- **Founder / ops manager:** [founder-email.md](outbound-assets/founder-email.md)
- **Agency / Shopify partner:** [agency-email.md](outbound-assets/agency-email.md)
- **Follow-up sequence:** [follow-up-sequence.md](outbound-assets/follow-up-sequence.md)

## Demo Motion

1. Ask for one sample PO before asking for any Shopify install.
2. Explicitly say a redacted or old fulfilled PO is acceptable for the demo.
3. Run the sample through DraftBridge and send back proof: the source document,
   matched lines, resulting draft order, and any exception handling.
4. Only after the proof lands, send a direct install link:
   `https://draftbridge.onrender.com/auth/login?shop={{shop_domain}}`
5. Show the merchant exception queue for low-confidence cases, then show the
   internal ops queue only as the support backstop.
6. Quote time saved and error reduction instead of generic AI language.

## Positioning

- "Email/PDF purchase orders to validated Shopify draft orders."
- "Forward wholesale POs. Get draft orders. Review only exceptions."
- "Stop retyping wholesale purchase orders."

## Cadence

- Touch 1: Personalized cold email (Day 0)
- Touch 2: Value-add follow-up with time-savings math (Day 3)
- Touch 3: Breakup with clear offer (Day 7)
- Never more than 3 emails without a reply
- If they reply positively, switch to the sample-PO demo setup flow
- After the first successful pilots, ask for Shopify App Store reviews

## Channels (Priority Order)

1. **Direct cold email** — highest intent, lowest volume. Target 50–100
   qualified merchants in the first 30 days.
2. **Shopify App Store organic** — medium intent, growing volume. Requires
   a polished listing (see [app-store-listing-copy.md](app-store-listing-copy.md)).
3. **Landing page at draftbridgehq.com** — catches Google traffic and gives
   cold-emailed merchants a trust verification point.
4. **Shopify partner / agency referrals** — use the agency template after
   the first 3–5 direct pilots are successful.

## First 30 Days Target

- 50 qualified merchants identified and recorded
- 50 cold emails sent
- 5 sample PO demos completed
- 2–3 trial installs
- 1 paid conversion
- 3 review requests sent to successful pilots
