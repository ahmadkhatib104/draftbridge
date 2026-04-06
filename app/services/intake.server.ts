import { createHash } from "node:crypto";
import type { ParseStatus, SourceDocument, SourceDocumentKind } from "@prisma/client";
import db from "../db.server";
import { createAuditEvent } from "./audit.server";
import {
  inferSourceDocumentKind,
  parseDocumentContent,
  type ParsedSpreadsheetRow,
} from "./document-parser.server";
import { processSourceDocument } from "./processing.server";
import { advanceOnboardingStatus } from "./shop.server";
import {
  getStoredDocumentContentBase64,
  persistSourceDocumentContent,
} from "./storage.server";

interface NormalizedInboundAttachment {
  filename?: string | null;
  contentType?: string | null;
  contentLength?: number | null;
  contentBase64?: string | null;
}

interface NormalizedInboundHeader {
  name?: string | null;
  value?: string | null;
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
  headers?: NormalizedInboundHeader[];
  attachments?: NormalizedInboundAttachment[];
}

interface PreparedSourceDocument {
  sourceDocument: SourceDocument;
  structuredRows: ParsedSpreadsheetRow[];
}

interface QueuedInboundProcessingResult {
  inboundMessageId: string;
  deduped: boolean;
  queued: boolean;
}

interface SourceDocumentCandidateScoreInput {
  kind: SourceDocumentKind;
  parseStatus: ParseStatus;
  filename?: string | null;
  extractedText?: string | null;
  sequence?: number | null;
  hasAttachments?: boolean;
}

const PRIMARY_FILENAME_HINT = /(po|purchase.?order|order|wholesale)/i;
const SUPPORTING_FILENAME_HINT = /(packing|terms|conditions|instructions|readme|spec|invoice|receipt)/i;
const FORWARDED_MESSAGE_MARKER =
  /(?:^|\n)(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)/i;
const scheduledInboundMessageIds = new Set<string>();
let inboundProcessingQueueScheduled = false;
let inboundProcessingQueueActive = false;

interface ResolvedInboundSender {
  senderEmail: string;
  senderName: string | null;
  forwardedByEmail: string | null;
  source: "payload" | "headers" | "forwarded-body";
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

function normalizeHeaderName(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function parseMailboxLine(value: string) {
  const trimmed = value.trim();
  const angleMatch = trimmed.match(/^(.*?)<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>$/i);

  if (angleMatch) {
    return {
      email: normalizeEmailAddress(angleMatch[2]),
      name: angleMatch[1]?.replace(/^"+|"+$/g, "").trim() || null,
    };
  }

  const mailtoMatch = trimmed.match(/^(.*?)\[mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\]$/i);

  if (mailtoMatch) {
    return {
      email: normalizeEmailAddress(mailtoMatch[2]),
      name: mailtoMatch[1]?.replace(/^"+|"+$/g, "").trim() || null,
    };
  }

  const directEmail = normalizeEmailAddress(trimmed);

  if (directEmail) {
    const name = trimmed.replace(directEmail, "").replace(/[<>[\]"]/g, "").trim();

    return {
      email: directEmail,
      name: name || null,
    };
  }

  return null;
}

function getHeaderValue(
  payload: NormalizedInboundEmailPayload,
  expectedNames: string[],
) {
  const normalizedNames = new Set(expectedNames.map((name) => name.toLowerCase()));

  for (const header of payload.headers ?? []) {
    const headerName = normalizeHeaderName(header.name);

    if (normalizedNames.has(headerName) && header.value?.trim()) {
      return header.value.trim();
    }
  }

  return null;
}

function extractForwardedSenderFromHeaders(
  payload: NormalizedInboundEmailPayload,
  receivedFromEmail: string,
) {
  const headerValue = getHeaderValue(payload, [
    "x-original-from",
    "x-forwarded-for",
    "resent-from",
    "original-from",
  ]);

  if (!headerValue) {
    return null;
  }

  const parsed = parseMailboxLine(headerValue);

  if (!parsed?.email || parsed.email === receivedFromEmail) {
    return null;
  }

  return parsed;
}

function extractForwardedSenderFromBody(
  payload: NormalizedInboundEmailPayload,
  receivedFromEmail: string,
) {
  const body = payload.textBody?.trim() || "";
  const subject = payload.subject?.trim() || "";
  const looksForwarded =
    FORWARDED_MESSAGE_MARKER.test(body) || /^(?:fw|fwd)\s*:/i.test(subject);

  if (!looksForwarded) {
    return null;
  }

  const forwardedSection =
    body.split(FORWARDED_MESSAGE_MARKER)[1] ??
    body;
  const headerBlock = forwardedSection.split(/\n\s*\n/)[0]?.slice(0, 2500) ?? forwardedSection;
  const mailboxPatterns = [
    /^(?:from|de)\s*:\s*(.+?)\s*<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>\s*$/im,
    /^(?:from|de)\s*:\s*(.+?)\s*\[mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\]\s*$/im,
    /^(?:from|de)\s*:\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*$/im,
  ];

  for (const pattern of mailboxPatterns) {
    const match = headerBlock.match(pattern);

    if (!match) {
      continue;
    }

    const emailCandidate = normalizeEmailAddress(match[2] ?? match[1]);

    if (!emailCandidate || emailCandidate === receivedFromEmail) {
      continue;
    }

    const nameCandidate = (match[2] ? match[1] : null)?.trim() || null;

    return {
      email: emailCandidate,
      name: nameCandidate,
    };
  }

  return null;
}

export function resolveInboundSender(payload: NormalizedInboundEmailPayload): ResolvedInboundSender {
  const receivedFromEmail = normalizeSenderEmail(payload);
  const receivedFromName = normalizeSenderName(payload);

  const headerSender = extractForwardedSenderFromHeaders(payload, receivedFromEmail);

  if (headerSender) {
    return {
      senderEmail: headerSender.email,
      senderName: headerSender.name,
      forwardedByEmail: receivedFromEmail || null,
      source: "headers",
    };
  }

  const bodySender = extractForwardedSenderFromBody(payload, receivedFromEmail);

  if (bodySender) {
    return {
      senderEmail: bodySender.email,
      senderName: bodySender.name,
      forwardedByEmail: receivedFromEmail || null,
      source: "forwarded-body",
    };
  }

  return {
    senderEmail: receivedFromEmail,
    senderName: receivedFromName,
    forwardedByEmail: null,
    source: "payload",
  };
}

export function assertInboundAuthenticationPassed(
  payload: NormalizedInboundEmailPayload,
  authenticatedSenderEmail: string,
) {
  const authHeader =
    payload.headers?.find(
      (header) => normalizeHeaderName(header.name) === "authentication-results",
    )?.value ?? "";
  const normalizedHeader = authHeader.toLowerCase();

  if (
    normalizedHeader &&
    (normalizedHeader.includes("dkim=fail") || normalizedHeader.includes("spf=fail"))
  ) {
    throw new Error(
      `Email spoofing detected: authentication failed for ${authenticatedSenderEmail}`,
    );
  }
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

function buildAttachmentFingerprint(attachments: NormalizedInboundAttachment[] | null | undefined) {
  return (attachments ?? [])
    .map((attachment) => [
      attachment.filename ?? "",
      attachment.contentType ?? "",
      String(attachment.contentLength ?? 0),
      attachment.contentBase64
        ? createHash("sha256").update(attachment.contentBase64).digest("hex")
        : "",
    ].join(":"))
    .join("|");
}

function buildMessageHash(
  payload: NormalizedInboundEmailPayload,
  senderEmail: string,
) {
  return createHash("sha256")
    .update(
      [
        payload.messageId || "",
        senderEmail,
        payload.subject || "",
        payload.date || "",
        payload.textBody || "",
        buildAttachmentFingerprint(payload.attachments),
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

function hasTerminalOrderStatus(status: string | null | undefined) {
  return status === "AUTO_DRAFTED" || status === "OPS_REVIEW" || status === "DUPLICATE";
}

export function scoreSourceDocumentCandidate(input: SourceDocumentCandidateScoreInput) {
  let score = 0;

  switch (input.kind) {
    case "XLSX":
      score += 520;
      break;
    case "CSV":
      score += 500;
      break;
    case "PDF":
      score += 420;
      break;
    case "IMAGE":
      score += 390;
      break;
    case "TEXT":
      score += 220;
      break;
    case "EMAIL_BODY":
      score += input.hasAttachments ? 80 : 280;
      break;
  }

  if (input.parseStatus === "PARSED") {
    score += 50;
  } else if (input.parseStatus === "FALLBACK_REQUIRED") {
    score += 20;
  } else if (input.parseStatus === "FAILED") {
    score -= 160;
  }

  const extractedTextLength = input.extractedText?.trim().length ?? 0;
  score += Math.min(extractedTextLength, 3000) / 100;
  score -= Math.max(input.sequence ?? 0, 0) * 2;

  if (PRIMARY_FILENAME_HINT.test(input.filename ?? "")) {
    score += 40;
  }

  if (SUPPORTING_FILENAME_HINT.test(input.filename ?? "")) {
    score -= 120;
  }

  return score;
}

function selectPrimarySourceDocument(documents: SourceDocument[]) {
  const hasAttachments = documents.some((document) => document.kind !== "EMAIL_BODY");

  return documents
    .slice()
    .sort((left, right) => {
      const leftScore = scoreSourceDocumentCandidate({
        kind: left.kind,
        parseStatus: left.parseStatus,
        filename: left.filename,
        extractedText: left.extractedText,
        sequence: left.sequence,
        hasAttachments,
      });
      const rightScore = scoreSourceDocumentCandidate({
        kind: right.kind,
        parseStatus: right.parseStatus,
        filename: right.filename,
        extractedText: right.extractedText,
        sequence: right.sequence,
        hasAttachments,
      });

      return rightScore - leftScore || left.sequence - right.sequence;
    })[0] ?? null;
}

async function createSourceDocumentsForMessage(input: {
  inboundMessageId: string;
  shopId: string;
  textBody?: string | null;
  attachments?: NormalizedInboundAttachment[];
}) {
  const documentInputs: Array<{
    filename?: string | null;
    contentType?: string | null;
    contentBase64: string;
    isEmailBody?: boolean;
  }> = [];

  if (input.textBody?.trim()) {
    documentInputs.push({
      filename: "email-body.txt",
      contentType: "text/plain",
      contentBase64: createTextBodyBase64(input.textBody),
      isEmailBody: true,
    });
  }

  for (const attachment of input.attachments ?? []) {
    if (!attachment.contentBase64) {
      continue;
    }

    documentInputs.push({
      filename: attachment.filename ?? null,
      contentType: attachment.contentType ?? null,
      contentBase64: attachment.contentBase64,
    });
  }

  const preparedDocuments: PreparedSourceDocument[] = [];

  for (const [index, documentInput] of documentInputs.entries()) {
    const kind = inferSourceDocumentKind({
      filename: documentInput.filename,
      contentType: documentInput.contentType,
      isEmailBody: documentInput.isEmailBody,
    });
    const persistedContent = await persistSourceDocumentContent({
      shopId: input.shopId,
      inboundMessageId: input.inboundMessageId,
      sequence: index,
      filename: documentInput.filename,
      contentType: documentInput.contentType,
      contentBase64: documentInput.contentBase64,
    });
    const sourceDocument = await db.sourceDocument.create({
      data: {
        shopId: input.shopId,
        inboundMessageId: input.inboundMessageId,
        kind,
        filename: documentInput.filename ?? undefined,
        contentType: documentInput.contentType ?? undefined,
        contentSize: Buffer.from(documentInput.contentBase64, "base64").byteLength,
        contentHash: buildDocumentHash(documentInput.contentBase64),
        storageProvider: persistedContent.storageProvider,
        storageKey: persistedContent.storageKey ?? undefined,
        contentBase64: persistedContent.contentBase64 ?? undefined,
        parseStatus: "PENDING",
        sequence: index,
      },
    });

    preparedDocuments.push({
      sourceDocument,
      structuredRows: [],
    });
  }

  return preparedDocuments;
}

async function reparseSourceDocument(sourceDocument: SourceDocument, rawTextBody?: string | null) {
  const contentBase64 = await getStoredDocumentContentBase64({
    storageProvider: sourceDocument.storageProvider,
    storageKey: sourceDocument.storageKey,
    contentBase64: sourceDocument.contentBase64,
  });

  const parsed = await parseDocumentContent({
    kind: sourceDocument.kind,
    contentBase64,
    textBody: sourceDocument.kind === "EMAIL_BODY" ? rawTextBody ?? undefined : undefined,
    filename: sourceDocument.filename,
    contentType: sourceDocument.contentType,
  });

  const refreshedDocument = await db.sourceDocument.update({
    where: { id: sourceDocument.id },
    data: {
      extractedText: parsed.extractedText ?? undefined,
      pageCount: parsed.pageCount ?? undefined,
      parseStatus: parsed.parseStatus,
      parseError: parsed.parseError ?? undefined,
    },
  });

  return {
    sourceDocument: refreshedDocument,
    structuredRows: parsed.structuredRows,
  } satisfies PreparedSourceDocument;
}

function buildSupplementalText(input: {
  subject?: string | null;
  rawTextBody?: string | null;
  primarySourceDocument: SourceDocument;
}) {
  const parts = [
    input.subject?.trim() ? `Subject: ${input.subject.trim()}` : null,
    input.primarySourceDocument.kind === "EMAIL_BODY" ? null : input.rawTextBody?.trim() || null,
  ].filter((value): value is string => Boolean(value));

  return parts.join("\n\n").slice(0, 4000) || null;
}

async function syncInboundMessageState(inboundMessageId: string, incrementAttempt: boolean) {
  const latestOrder = await db.purchaseOrder.findFirst({
    where: { inboundMessageId },
    orderBy: { createdAt: "desc" },
  });

  return db.inboundMessage.update({
    where: { id: inboundMessageId },
    data: {
      status: latestOrder?.status === "AUTO_DRAFTED"
        ? "AUTO_DRAFTED"
        : latestOrder?.status === "OPS_REVIEW" || latestOrder?.status === "DUPLICATE"
          ? "OPS_REVIEW"
          : latestOrder
            ? "PARSED"
            : "FAILED",
      processingAttempts: incrementAttempt
        ? {
            increment: 1,
          }
        : undefined,
      lastProcessedAt: incrementAttempt ? new Date() : undefined,
      lastError: null,
    },
  });
}

async function prepareSourceDocuments(
  sourceDocuments: SourceDocument[],
  rawTextBody?: string | null,
) {
  return Promise.all(
    sourceDocuments.map((sourceDocument) =>
      reparseSourceDocument(sourceDocument, rawTextBody),
    ),
  );
}

function scheduleInboundQueueDrain() {
  if (inboundProcessingQueueScheduled) {
    return;
  }

  inboundProcessingQueueScheduled = true;
  setTimeout(() => {
    inboundProcessingQueueScheduled = false;
    void drainScheduledInboundMessages();
  }, 0);
}

async function drainScheduledInboundMessages() {
  if (inboundProcessingQueueActive) {
    return;
  }

  inboundProcessingQueueActive = true;

  try {
    while (scheduledInboundMessageIds.size > 0) {
      const nextInboundMessageId = scheduledInboundMessageIds.values().next().value;

      if (!nextInboundMessageId) {
        break;
      }

      scheduledInboundMessageIds.delete(nextInboundMessageId);

      try {
        await processPersistedInboundMessage(nextInboundMessageId);
      } catch (error) {
        console.error("Failed background inbound processing", {
          inboundMessageId: nextInboundMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    inboundProcessingQueueActive = false;

    if (scheduledInboundMessageIds.size > 0) {
      scheduleInboundQueueDrain();
    }
  }
}

export function queueInboundMessageProcessing(inboundMessageId: string) {
  scheduledInboundMessageIds.add(inboundMessageId);
  scheduleInboundQueueDrain();
}

export async function drainPendingInboundMessages(limit = 25) {
  const pendingMessages = await db.inboundMessage.findMany({
    where: {
      status: "RECEIVED",
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  for (const pendingMessage of pendingMessages) {
    await processPersistedInboundMessage(pendingMessage.id);
  }

  return pendingMessages.length;
}

export async function processPersistedInboundMessage(inboundMessageId: string) {
  const inboundMessage = await db.inboundMessage.findUniqueOrThrow({
    where: { id: inboundMessageId },
    include: {
      sourceDocuments: {
        orderBy: { sequence: "asc" },
      },
      mailbox: {
        include: {
          shop: true,
        },
      },
    },
  });

  const latestOrder = await db.purchaseOrder.findFirst({
    where: {
      inboundMessageId,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
    },
  });

  if (latestOrder && hasTerminalOrderStatus(latestOrder.status)) {
    await syncInboundMessageState(inboundMessageId, false);
    return latestOrder;
  }

  const preparedDocuments = await prepareSourceDocuments(
    inboundMessage.sourceDocuments,
    inboundMessage.rawTextBody,
  );
  const primarySourceDocument = selectPrimarySourceDocument(
    preparedDocuments.map((document) => document.sourceDocument),
  );

  if (!primarySourceDocument) {
    await db.inboundMessage.update({
      where: { id: inboundMessageId },
      data: {
        status: "FAILED",
        processingAttempts: {
          increment: 1,
        },
        lastProcessedAt: new Date(),
        lastError: "No parseable source document was stored for this email.",
      },
    });

    return null;
  }

  const senderProfile = await db.senderProfile.findUniqueOrThrow({
    where: {
      shopId_senderEmail: {
        shopId: inboundMessage.shopId,
        senderEmail: inboundMessage.senderEmail,
      },
    },
  });

  const preparedDocument =
    preparedDocuments.find(
      (document) => document.sourceDocument.id === primarySourceDocument.id,
    )!;

  try {
    const order = await processSourceDocument({
      shopId: inboundMessage.shopId,
      shopDomain: inboundMessage.mailbox.shop.shopDomain,
      inboundMessageId,
      mailboxId: inboundMessage.mailboxId,
      senderProfile,
      sourceDocument: preparedDocument.sourceDocument,
      structuredRows: preparedDocument.structuredRows,
      supplementalText: buildSupplementalText({
        subject: inboundMessage.subject,
        rawTextBody: inboundMessage.rawTextBody,
        primarySourceDocument: preparedDocument.sourceDocument,
      }),
      existingPurchaseOrderId: latestOrder?.id ?? undefined,
    });

    await syncInboundMessageState(inboundMessageId, true);
    return order;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Inbound message processing failed.";

    await db.inboundMessage.update({
      where: { id: inboundMessageId },
      data: {
        status: "FAILED",
        processingAttempts: {
          increment: 1,
        },
        lastProcessedAt: new Date(),
        lastError: errorMessage,
      },
    });

    throw error;
  }
}

export async function handleInboundEmail(
  payload: NormalizedInboundEmailPayload,
): Promise<QueuedInboundProcessingResult> {
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

  const senderIdentity = resolveInboundSender(payload);
  const senderEmail = senderIdentity.senderEmail;
  if (!senderEmail) {
    throw new Error("Could not determine sender email from inbound email.");
  }
  assertInboundAuthenticationPassed(
    payload,
    senderIdentity.forwardedByEmail ?? senderEmail,
  );

  const senderName = senderIdentity.senderName;
  const dedupeHash = buildMessageHash(payload, senderEmail);

  await db.senderProfile.upsert({
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

  let inboundMessage = await db.inboundMessage.findUnique({
    where: {
      shopId_dedupeHash: {
        shopId: mailbox.shopId,
        dedupeHash,
      },
    },
  });

  let deduped = false;
  if (!inboundMessage) {
    inboundMessage = await db.inboundMessage.create({
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

    await createSourceDocumentsForMessage({
      inboundMessageId: inboundMessage.id,
      shopId: mailbox.shopId,
      textBody: payload.textBody,
      attachments: payload.attachments,
    });

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
        senderSource: senderIdentity.source,
        forwardedByEmail: senderIdentity.forwardedByEmail,
      },
    });

    await advanceOnboardingStatus(mailbox.shopId, "SAMPLE_RECEIVED");
  } else {
    deduped = true;
  }

  queueInboundMessageProcessing(inboundMessage.id);

  return {
    inboundMessageId: inboundMessage.id,
    deduped,
    queued: true,
  };
}
