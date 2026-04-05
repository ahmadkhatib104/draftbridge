export const APP_NAME = "DraftBridge";
export const APP_PROMISE =
  "Email/PDF purchase orders to validated Shopify draft orders.";
export const APP_TAGLINE =
  "Forward wholesale POs. Get draft orders. Review only exceptions.";

export const APP_NAVIGATION = [
  { href: "/app", label: "Overview" },
  { href: "/app/onboarding", label: "Onboarding" },
  { href: "/app/orders", label: "Orders" },
  { href: "/app/exceptions", label: "Exceptions" },
  { href: "/app/billing", label: "Billing" },
  { href: "/app/reporting", label: "Reporting" },
  { href: "/app/settings", label: "Settings" },
] as const;
