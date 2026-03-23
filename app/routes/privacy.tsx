export default function PrivacyRoute() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Privacy</h1>
      <p>
        DraftBridge stores the minimum wholesale-order data needed to ingest purchase orders,
        validate line items, create Shopify draft orders, and keep an audit trail for merchant support.
      </p>
      <p>
        Original source documents are stored in merchant-scoped storage, and only authenticated app operators
        or merchant users with store access should review them.
      </p>
    </main>
  );
}
