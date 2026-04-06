import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
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

export async function purgeShopDocumentPrefix(shopId: string) {
  const client = getR2Client();

  if (!client) {
    return 0;
  }

  let deletedCount = 0;
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET!,
        Prefix: `${shopId}/`,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = (page.Contents ?? [])
      .map((entry) => entry.Key)
      .filter((key): key is string => Boolean(key));

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET!,
          Delete: {
            Objects: objects.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );

      deletedCount += objects.length;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deletedCount;
}

export async function deleteStoredDocumentKeys(keys: string[]) {
  const client = getR2Client();

  if (!client || keys.length === 0) {
    return 0;
  }

  let deletedCount = 0;

  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000);

    await client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.R2_BUCKET!,
        Delete: {
          Objects: batch.map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );

    deletedCount += batch.length;
  }

  return deletedCount;
}

export async function getStoredDocumentContentBase64(input: {
  storageProvider: string;
  storageKey?: string | null;
  contentBase64?: string | null;
}) {
  if (input.storageProvider === "database") {
    return input.contentBase64 ?? null;
  }

  const client = getR2Client();

  if (!client || !input.storageKey) {
    return null;
  }

  const response = await client.send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: input.storageKey,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();

  if (!bytes) {
    return null;
  }

  return Buffer.from(bytes).toString("base64");
}
