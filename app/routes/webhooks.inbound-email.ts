import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { handleInboundEmail, type NormalizedInboundEmailPayload } from "../services/intake.server";

const EMAIL_INGEST_SECRET_HEADER = "x-email-ingest-secret";

function assertEmailIngestSecret(request: Request) {
  const expectedSecret = process.env.EMAIL_INGEST_SHARED_SECRET?.trim();

  if (!expectedSecret) {
    throw new Response("Email ingest is not configured", { status: 503 });
  }

  const providedSecret = request.headers.get(EMAIL_INGEST_SECRET_HEADER)?.trim();
  if (!providedSecret) {
    throw new Response("Missing email ingest secret", { status: 401 });
  }

  const expectedBuffer = Buffer.from(expectedSecret);
  const providedBuffer = Buffer.from(providedSecret);
  const secretsMatch =
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);

  if (!secretsMatch) {
    throw new Response("Invalid email ingest secret", { status: 401 });
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  assertEmailIngestSecret(request);

  const payload = (await request.json()) as NormalizedInboundEmailPayload;
  const result = await handleInboundEmail(payload);

  return Response.json(result, { status: 202 });
};
