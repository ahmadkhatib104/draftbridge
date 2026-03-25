export default function TermsRoute() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Terms</h1>
      <p>
        DraftBridge is a merchant workflow tool for converting inbound wholesale purchase orders into validated Shopify
        draft orders. By installing or using the app, the merchant authorizes DraftBridge to process merchant data as
        needed to provide the service.
      </p>
      <p>
        The merchant remains responsible for the accuracy of source documents, the customer relationships represented in
        those documents, and final approval of any draft orders before fulfillment. DraftBridge may hold low-confidence
        or failed cases for manual review instead of creating a draft order automatically.
      </p>
      <p>
        DraftBridge acts as a service provider or processor for merchant data and uses that data only to provide,
        secure, support, and improve the app for the installing merchant. Merchant data is not sold.
      </p>
      <p>
        If the merchant uninstalls the app, DraftBridge may retain limited records for up to 90 days to complete
        deletion workflows, resolve support issues, or meet legal obligations, after which merchant-scoped personal data
        is targeted for deletion unless law or an active dispute requires temporary preservation.
      </p>
      <p>
        Questions about these terms can be directed through the support channel listed at <a href="/support">/support</a>.
      </p>
    </main>
  );
}
