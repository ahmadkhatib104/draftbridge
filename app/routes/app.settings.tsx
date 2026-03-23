import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";
import { hasEmailIngestConfig, hasOpenAiConfig, hasR2Config } from "../lib/env.server";
import { requireShopContext } from "../services/shop-context.server";
import { getPrimaryMailbox } from "../services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShopContext(request);
  const [mailbox, senderProfiles] = await Promise.all([
    getPrimaryMailbox(shop.id),
    db.senderProfile.findMany({
      where: { shopId: shop.id },
      orderBy: { lastSeenAt: "desc" },
      take: 20,
    }),
  ]);

  return {
    shop,
    mailbox,
    senderProfiles,
    configReadiness: {
      openAi: hasOpenAiConfig(),
      r2: hasR2Config(),
      emailRoutingDomain: process.env.EMAIL_ROUTING_DOMAIN || null,
      emailIngestSecret: hasEmailIngestConfig(),
    },
  };
};

export default function SettingsRoute() {
  const { mailbox, senderProfiles, configReadiness } = useLoaderData<typeof loader>();

  return (
    <div style={{ padding: "1rem" }}>
      <s-page heading="Settings">
        <s-card heading="Forwarding setup">
          <s-paragraph>Primary mailbox: {mailbox.forwardingAddress}</s-paragraph>
          <s-paragraph>Inbound domain: {mailbox.inboundDomain}</s-paragraph>
        </s-card>

        <s-card heading="Environment readiness">
          <s-paragraph>OpenAI configured: {configReadiness.openAi ? "yes" : "no"}</s-paragraph>
          <s-paragraph>R2 configured: {configReadiness.r2 ? "yes" : "no"}</s-paragraph>
          <s-paragraph>
            Email routing domain: {configReadiness.emailRoutingDomain || "not set"}
          </s-paragraph>
          <s-paragraph>
            Email ingest secret: {configReadiness.emailIngestSecret ? "set" : "not set"}
          </s-paragraph>
        </s-card>

        <s-card heading="Known senders">
          {senderProfiles.length === 0 ? (
            <s-paragraph>No retailer senders have been learned yet.</s-paragraph>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {senderProfiles.map((profile) => (
                <div key={profile.id}>
                  <strong>{profile.senderEmail}</strong>
                  <p style={{ margin: "0.25rem 0 0" }}>
                    {profile.companyName || profile.customerName || "Unknown account"} | Last seen{" "}
                    {profile.lastSeenAt ? new Date(profile.lastSeenAt).toLocaleString() : "never"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </s-card>
      </s-page>
    </div>
  );
}
