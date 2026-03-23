function normalizeUrl(value: string | null | undefined) {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

export function getAppUrl() {
  return (
    normalizeUrl(process.env.SHOPIFY_APP_URL) ||
    normalizeUrl(process.env.RENDER_EXTERNAL_URL)
  );
}

export function requireAppUrl() {
  const appUrl = getAppUrl();

  if (!appUrl) {
    throw new Error("Missing SHOPIFY_APP_URL or RENDER_EXTERNAL_URL.");
  }

  return appUrl;
}

export function getEmailRoutingDomain() {
  return process.env.EMAIL_ROUTING_DOMAIN?.trim() || "example.com";
}

export function hasEmailIngestConfig() {
  return Boolean(process.env.EMAIL_INGEST_SHARED_SECRET?.trim());
}

export function hasOpenAiConfig() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID?.trim() &&
      process.env.R2_ACCESS_KEY_ID?.trim() &&
      process.env.R2_SECRET_ACCESS_KEY?.trim() &&
      process.env.R2_BUCKET?.trim(),
  );
}
