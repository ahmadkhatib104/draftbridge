import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { requireShopContext } from "../services/shop-context.server";
import { getPrimaryMailbox } from "../services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const mailbox = await getPrimaryMailbox(shop.id);

  return {
    shop,
    mailbox,
  };
};

export default function OnboardingRoute() {
  const { shop, mailbox } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Onboarding">
        <s-card heading="1. Set up forwarding">
          <s-paragraph>
            Configure your Cloudflare Email Routing address and forward inbound wholesale POs to{" "}
            <s-text>{mailbox.forwardingAddress}</s-text>.
          </s-paragraph>
          <s-paragraph>
            The app accepts email body text, PDF attachments, CSV, and XLSX files.
          </s-paragraph>
        </s-card>
        <s-card heading="2. Send a sample PO">
          <s-paragraph>
            Send one sample order from a real retailer contact so DraftBridge can learn the sender and spreadsheet format.
          </s-paragraph>
        </s-card>
        <s-card heading="3. Confirm the result">
          <s-paragraph>
            High-confidence POs will create Shopify draft orders automatically. Lower-confidence POs will stay in review until DraftBridge ops resolves them or you add clarification from the order detail page.
          </s-paragraph>
          <s-paragraph>Current onboarding status: {shop.onboardingStatus}</s-paragraph>
        </s-card>
      </s-page>
    </div>
  );
}
