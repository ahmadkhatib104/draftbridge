import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import db from "../db.server";

function assertOpsAccess(request: Request) {
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  assertOpsAccess(request);

  const cases = await db.opsCase.findMany({
    where: {
      status: {
        in: ["OPEN", "IN_PROGRESS", "WAITING_ON_MERCHANT"],
      },
    },
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    include: {
      purchaseOrder: {
        include: {
          lineItems: true,
          validationIssues: true,
        },
      },
      shop: true,
    },
  });

  return { cases };
};

export default function OpsCasesRoute() {
  const { cases } = useLoaderData<typeof loader>();

  return (
    <main style={{ maxWidth: 1120, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <h1>DraftBridge Ops Queue</h1>
      {cases.length === 0 ? (
        <p>No open ops cases.</p>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {cases.map((opsCase) => (
            <section
              key={opsCase.id}
              style={{
                padding: "1rem",
                border: "1px solid #dfe3e8",
                borderRadius: "12px",
              }}
            >
              <h2 style={{ marginTop: 0 }}>
                {opsCase.shop.shopDomain} | {opsCase.purchaseOrder.poNumber || "PO pending number"}
              </h2>
              <p>{opsCase.summary}</p>
              <p>Status: {opsCase.status} | Priority: {opsCase.priority}</p>
              <p>
                {opsCase.purchaseOrder.companyName || opsCase.purchaseOrder.customerName || opsCase.purchaseOrder.contactEmail || "Unknown customer"}
              </p>
              <ul>
                {opsCase.purchaseOrder.validationIssues.map((issue) => (
                  <li key={issue.id}>
                    {issue.code}: {issue.message}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
