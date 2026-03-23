import { createHash } from "node:crypto";
import db from "../db.server";
import { createAuditEvent } from "./audit.server";
import {
  inferSourceDocumentKind,
  parseDocumentContent,
  type ParsedSpreadsheetRow,
} from "./document-parser.server";
import { processSourceDocument } from "./processing.server";
import { persistSourceDocumentContent } from "./storage.server";

interface NormalizedInboundAttachment {
  filename?: string | null;
  contentType?: string | null;
  contentLength?: number | null;
  contentBase64?: string | null;
}

export interface NormalizedInboundEmailPayload {
  messageId?: string | null;
  from?: string | null;
  fromName?: string | null;
  to?: string | string[] | null;
  subject?: string | null;
  date?: string | null;
  routingKey?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  attachments?: NormalizedInboundAttachment[];
}

function normalizeEmailAddress(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch?.[0]?.toLowerCase() ?? value.trim().toLowerCase();
}

function normalizePrimaryRecipient(value: string | string[] | null | undefined) {
  if (Array.isArray(value)) {
    return normalizeEmailAddress(value.find(Boolean));
  }

  return normalizeEmailAddress(value);
}

function normalizeSenderEmail(payload: NormalizedInboundEmailPayload) {
  return normalizeEmailAddress(payload.from);
}

function normalizeSenderName(payload: NormalizedInboundEmailPayload) {
  return payload.fromName?.trim() || null;
}

function inferMailboxRoutingKey(payload: NormalizedInboundEmailPayload) {
  if (payload.routingKey?.trim()) {
    return payload.routingKey.trim().toLowerCase();
  }

  const recipient = normalizePrimaryRecipient(payload.to);
  if (!recipient) {
    return "";
  }

  return recipient.split("@")[0]?.toLowerCase() ?? "";
}

function buildMessageHash(payload: NormalizedInboundEmailPayload) {
  return createHash("sha256")
    .update(
      [
        payload.messageId || "",
        normalizeSenderEmail(payload),
        payload.subject || "",
        payload.date || "",
        payload.textBody || "",
      ].join("|"),
    )
    .digest("hex");
}

function buildDocumentHash(contentBase64: string) {
  return createHash("sha256")
    .update(contentBase64)
    .digest("hex");
}

function createTextBodyBase64(textBody: string) {
  return Buffer.from(textBody, "utf8").toString("base64");
}

export async function handleInboundEmail(payload: NormalizedInboundEmailPayload) {
  const routingKey = inferMailboxRoutingKey(payload);

  if (!routingKey) {
    throw new Error("Could not determine mailbox routing key from inbound email.");
  }

  const mailbox = await db.mailbox.findUnique({
    where: { routingKey },
    include: { shop: true },
  });

  if (!mailbox) {
    throw new Error(`No mailbox is configured for routing key ${routingKey}.`);
  }

  const senderEmail = normalizeSenderEmail(payload);
  if (!senderEmail) {
    throw new Error("Could not determine sender email from inbound email.");
  }

  const senderName = normalizeSenderName(payload);
  const dedupeHash = buildMessageHash(payload);

  const existingMessage = await db.inboundMessage.findUnique({
    where: {
      shopId_dedupeHash: {
        shopId: mailbox.shopId,
        dedupeHash,
      },
    },
  });

  if (existingMessage) {
    return {
      inboundMessageId: existingMessage.id,
      deduped: true,
    };
  }

  const senderProfile = await db.senderProfile.upsert({
    where: {
      shopId_senderEmail: {
        shopId: mailbox.shopId,
        senderEmail,
      },
    },
    update: {
      senderDomain: senderEmail.split("@")[1] || "",
      companyName: senderName ?? undefined,
      contactEmail: senderEmail,
      sampleSubject: payload.subject ?? undefined,
      lastSeenAt: new Date(payload.date || Date.now()),
    },
    create: {
      shopId: mailbox.shopId,
      senderEmail,
      senderDomain: senderEmail.split("@")[1] || "",
      companyName: senderName ?? undefined,
      contactEmail: senderEmail,
      sampleSubject: payload.subject ?? undefined,
      lastSeenAt: new Date(payload.date || Date.now()),
    },
  });

  const inboundMessage = await db.inboundMessage.create({
    data: {
      shopId: mailbox.shopId,
      mailboxId: mailbox.id,
      externalMessageId: payload.messageId ?? undefined,
      dedupeHash,
      senderEmail,
      senderName: senderName ?? undefined,
      subject: payload.subject ?? undefined,
      rawTextBody: payload.textBody ?? undefined,
      rawHtmlBody: payload.htmlBody ?? undefined,
      receivedAt: new Date(payload.date || Date.now()),
    },
  });

  const documentInputs: Array<{
    filename?: string | null;
    contentType?: string | null;
    contentBase64: string;
    isEmailBody?: boolean;
  }> = [];

  if (payload.textBody?.trim()) {
    documentInputs.push({
      filename: "email-body.txt",
      contentType: "text/plain",
      contentBase64: createTextBodyBase64(payload.textBody),
      isEmailBody: true,
    });
  }

  for (const attachment of payload.attachments ?? []) {
    if (!attachment.contentBase64) {
      continue;
    }

    documentInputs.push({
      filename: attachment.filename ?? null,
      contentType: attachment.contentType ?? null,
      contentBase64: attachment.contentBase64,
    });
  }

  const createdDocuments: Array<{
    documentId: string;
    structuredRows: ParsedSpreadsheetRow[];
  }> = [];

  for (const [index, documentInput] of documentInputs.entries()) {
    const kind = inferSourceDocumentKind({
      filename: documentInput.filename,
      contentType: documentInput.contentType,
      isEmailBody: documentInput.isEmailBody,
    });
    const parsed = await parseDocumentContent({
      kind,
      contentBase64: documentInput.contentBase64,
      textBody: documentInput.isEmailBody ? payload.textBody ?? undefined : undefined,
    });
    const persistedContent = await persistSourceDocumentContent({
      shopId: mailbox.shopId,
      inboundMessageId: inboundMessage.id,
      sequence: index,
      filename: documentInput.filename,
      contentType: documentInput.contentType,
      contentBase64: documentInput.contentBase64,
    });
    const document = await db.sourceDocument.create({
      data: {
        shopId: mailbox.shopId,
        inboundMessageId: inboundMessage.id,
        kind,
        filename: documentInput.filename ?? undefined,
        contentType: documentInput.contentType ?? undefined,
        contentSize: Buffer.from(documentInput.contentBase64, "base64").byteLength,
        contentHash: buildDocumentHash(documentInput.contentBase64),
        storageProvider: persistedContent.storageProvider,
        storageKey: persistedContent.storageKey ?? undefined,
        contentBase64: persistedContent.contentBase64 ?? undefined,
        extractedText: parsed.extractedText ?? undefined,
        pageCount: parsed.pageCount ?? undefined,
        parseStatus: parsed.parseStatus,
        parseError: parsed.parseError ?? undefined,
        sequence: index,
      },
    });

    createdDocuments.push({
      documentId: document.id,
      structuredRows: parsed.structuredRows,
    });
  }

  await db.mailbox.update({
    where: { id: mailbox.id },
    data: { lastInboundAt: inboundMessage.receivedAt },
  });

  await createAuditEvent({
    shopId: mailbox.shopId,
    entityType: "MESSAGE",
    entityId: inboundMessage.id,
    action: "INBOUND_EMAIL_RECEIVED",
    summary: `Received PO email from ${senderEmail}.`,
    metadata: {
      subject: payload.subject ?? null,
      attachmentCount: payload.attachments?.length ?? 0,
    },
  });

  for (const createdDocument of createdDocuments) {
    const sourceDocument = await db.sourceDocument.findUniqueOrThrow({
      where: { id: createdDocument.documentId },
    });

    await processSourceDocument({
      shopId: mailbox.shopId,
      shopDomain: mailbox.shop.shopDomain,
      inboundMessageId: inboundMessage.id,
      mailboxId: mailbox.id,
      senderProfile,
      sourceDocument,
      structuredRows: createdDocument.structuredRows,
    });
  }

  const latestOrder = await db.purchaseOrder.findFirst({
    where: { inboundMessageId: inboundMessage.id },
    orderBy: { createdAt: "desc" },
  });

  await db.inboundMessage.update({
    where: { id: inboundMessage.id },
    data: {
      status: latestOrder?.status === "AUTO_DRAFTED"
        ? "AUTO_DRAFTED"
        : latestOrder?.status === "OPS_REVIEW" || latestOrder?.status === "DUPLICATE"
          ? "OPS_REVIEW"
          : latestOrder
            ? "PARSED"
            : "FAILED",
      processingAttempts: {
        increment: 1,
      },
      lastProcessedAt: new Date(),
    },
  });

  return {
    inboundMessageId: inboundMessage.id,
    deduped: false,
  };
}
