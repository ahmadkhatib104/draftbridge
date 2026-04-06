import db from "../app/db.server";
import { deleteStoredDocumentKeys } from "../app/services/storage.server";

const RETENTION_WINDOW_DAYS = 30;

async function pruneStaleDocuments() {
  const cutoff = new Date(
    Date.now() - RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const staleStoredDocuments = await db.sourceDocument.findMany({
    where: {
      createdAt: { lt: cutoff },
      storageKey: { not: null },
    },
    select: {
      storageKey: true,
    },
  });

  const deletedStoredDocumentCount = await deleteStoredDocumentKeys(
    staleStoredDocuments
      .map((document) => document.storageKey)
      .filter((storageKey): storageKey is string => Boolean(storageKey)),
  );

  const scrubbedInboundMessages = await db.inboundMessage.updateMany({
    where: {
      receivedAt: { lt: cutoff },
      OR: [{ rawTextBody: { not: null } }, { rawHtmlBody: { not: null } }],
    },
    data: {
      rawTextBody: null,
      rawHtmlBody: null,
    },
  });

  const scrubbedSourceDocuments = await db.sourceDocument.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ contentBase64: { not: null } }, { storageKey: { not: null } }],
    },
    data: {
      contentBase64: null,
      storageKey: null,
    },
  });

  console.log(
    `Pruned stale documents successfully. Scrubbed ${scrubbedInboundMessages.count} inbound messages, scrubbed ${scrubbedSourceDocuments.count} source documents, deleted ${deletedStoredDocumentCount} R2 objects.`,
  );
}

await pruneStaleDocuments();
