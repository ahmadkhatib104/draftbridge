export default function PrivacyRoute() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Privacy</h1>
      <p>
        DraftBridge processes the minimum wholesale-order data needed to ingest purchase orders, validate line items,
        create Shopify draft orders, and keep an audit trail for merchant support.
      </p>
      <p>
        For each merchant, this can include inbound email metadata, attached source documents, extracted PO fields,
        SKU matches, validation results, draft-order sync records, and support notes tied to the order workflow.
      </p>
      <p>
        DraftBridge uses merchant data only to operate the app, support merchants, improve merchant-specific parsing and
        mapping accuracy, prevent abuse, and meet legal obligations. DraftBridge does not sell customer data or use it
        for advertising.
      </p>
      <p>
        Original source documents are stored in merchant-scoped storage, and only authenticated merchant users with
        store access or authorized DraftBridge operators should review them when needed for support or exception
        handling.
      </p>
      <p>
        Data is encrypted in transit and, through our infrastructure providers, at rest. While a merchant is actively
        using the app, DraftBridge retains order-intake records needed to provide the service. After uninstall,
        DraftBridge targets deletion of merchant-scoped personal data within 90 days unless a longer retention period is
        required by law or an active security, billing, or dispute issue requires temporary preservation.
      </p>
      <p>
        Current sub-processors used to operate the service include Shopify, Render, Neon, Cloudflare, and OpenAI for
        bounded extraction tasks when deterministic parsing is insufficient.
      </p>
    </main>
  );
}
