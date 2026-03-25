const processorRows = [
  ["Inbound purchase order intake", "Email metadata, PO documents, extracted order fields", "Receive, parse, validate, and route merchant wholesale orders"],
  ["Shopify synchronization", "Matched customer or order identifiers, draft-order payloads", "Create and monitor Shopify draft orders for the merchant"],
  ["Support and exception handling", "Order records, validation issues, support notes", "Resolve low-confidence or failed cases"],
  ["Model-assisted extraction", "Document text or image content needed for extraction", "Extract structured purchase-order fields when deterministic parsing is insufficient"],
];

export default function DataProcessingRoute() {
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Data Processing</h1>
      <p>
        DraftBridge processes merchant data on behalf of the installing merchant to provide wholesale order-intake
        automation. The merchant is the controller or business, and DraftBridge operates as a processor or service
        provider for the merchant’s data within the app workflow.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1.5rem" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #d0d7de", padding: "0.75rem 0.5rem" }}>Activity</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #d0d7de", padding: "0.75rem 0.5rem" }}>Data used</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #d0d7de", padding: "0.75rem 0.5rem" }}>Purpose</th>
          </tr>
        </thead>
        <tbody>
          {processorRows.map(([activity, dataUsed, purpose]) => (
            <tr key={activity}>
              <td style={{ borderBottom: "1px solid #eef2f6", padding: "0.75rem 0.5rem", verticalAlign: "top" }}>{activity}</td>
              <td style={{ borderBottom: "1px solid #eef2f6", padding: "0.75rem 0.5rem", verticalAlign: "top" }}>{dataUsed}</td>
              <td style={{ borderBottom: "1px solid #eef2f6", padding: "0.75rem 0.5rem", verticalAlign: "top" }}>{purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ marginTop: "1.5rem" }}>
        DraftBridge limits processing to what is needed to operate the app for the merchant, support merchants, and
        maintain security and auditability. Data is encrypted in transit, protected by provider-managed encryption at
        rest, and retained only while needed to provide the service and complete post-uninstall retention workflows.
      </p>
      <p>
        Current infrastructure providers include Shopify, Render, Neon, Cloudflare, and OpenAI. DraftBridge does not
        sell personal data and does not use merchant data for third-party advertising.
      </p>
    </main>
  );
}
