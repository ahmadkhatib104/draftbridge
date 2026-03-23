import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { hasR2Config } from "../lib/env.server";

let r2Client: S3Client | null = null;

function getR2Client() {
  if (!hasR2Config()) {
    return null;
  }

  if (!r2Client) {
    r2Client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }

  return r2Client;
}

function safeFilename(value: string | null | undefined) {
  return (value || "document")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export async function persistSourceDocumentContent(input: {
  shopId: string;
  inboundMessageId: string;
  sequence: number;
  filename?: string | null;
  contentType?: string | null;
  contentBase64: string;
}) {
  const client = getR2Client();

  if (!client) {
    return {
      storageProvider: "database",
      storageKey: null,
      contentBase64: input.contentBase64,
    };
  }

  const key = [
    input.shopId,
    input.inboundMessageId,
    `${String(input.sequence).padStart(3, "0")}-${safeFilename(input.filename)}`,
  ].join("/");

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      Body: Buffer.from(input.contentBase64, "base64"),
      ContentType: input.contentType ?? "application/octet-stream",
    }),
  );

  return {
    storageProvider: "r2",
    storageKey: key,
    contentBase64: null,
  };
}
