export function assertOpsAccess(request: Request) {
  const expectedToken = process.env.OPS_DASHBOARD_TOKEN?.trim();

  if (!expectedToken) {
    throw new Response("OPS_DASHBOARD_TOKEN is not configured.", { status: 503 });
  }

  const requestUrl = new URL(request.url);
  const providedToken =
    request.headers.get("x-ops-token") || requestUrl.searchParams.get("token");

  if (providedToken !== expectedToken) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

export function buildOpsPath(request: Request, pathname: string) {
  const requestUrl = new URL(request.url);
  const target = new URL(pathname, requestUrl.origin);
  const providedToken = requestUrl.searchParams.get("token");

  if (providedToken) {
    target.searchParams.set("token", providedToken);
  }

  return `${target.pathname}${target.search}`;
}
