import PostalMime from "postal-mime";

interface Env {
  INGEST_ENDPOINT: string;
  EMAIL_INGEST_SHARED_SECRET: string;
}

interface ParsedMailbox {
  address: string;
  name: string;
}

function normalizeEmailAddress(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch?.[0]?.toLowerCase() ?? value.trim().toLowerCase();
}

function deriveRoutingKey(recipient: string) {
  return recipient.split("@")[0]?.toLowerCase() ?? "";
}

function normalizeParsedMailbox(value: unknown): ParsedMailbox | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { address?: string; name?: string };
  return {
    address: normalizeEmailAddress(candidate.address),
    name: candidate.name?.trim() ?? "",
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function normalizeBinaryContent(content: unknown) {
  if (content instanceof ArrayBuffer) {
    const bytes = new Uint8Array(content);
    return {
      contentBase64: bytesToBase64(bytes),
      contentLength: bytes.byteLength,
    };
  }

  if (ArrayBuffer.isView(content)) {
    const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return {
      contentBase64: bytesToBase64(bytes),
      contentLength: bytes.byteLength,
    };
  }

  if (typeof content === "string") {
    const encoded = new TextEncoder().encode(content);
    return {
      contentBase64: bytesToBase64(encoded),
      contentLength: encoded.byteLength,
    };
  }

  return {
    contentBase64: "",
    contentLength: null,
  };
}

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    if (!env.INGEST_ENDPOINT?.trim()) {
      throw new Error("Missing INGEST_ENDPOINT.");
    }

    if (!env.EMAIL_INGEST_SHARED_SECRET?.trim()) {
      throw new Error("Missing EMAIL_INGEST_SHARED_SECRET.");
    }

    const parser = new PostalMime();
    const rawEmail = new Response(message.raw);
    const parsed = await parser.parse(await rawEmail.arrayBuffer());

    const parsedFrom = normalizeParsedMailbox(parsed.from);
    const parsedTo = Array.isArray(parsed.to)
      ? normalizeParsedMailbox(parsed.to.find(Boolean))
      : normalizeParsedMailbox(parsed.to);
    const recipient = normalizeEmailAddress(message.to || parsedTo?.address || "");

    const payload = {
      messageId: parsed.messageId || message.headers.get("Message-ID"),
      from: normalizeEmailAddress(message.from || parsedFrom?.address || ""),
      fromName: parsedFrom?.name || "",
      to: recipient,
      subject: parsed.subject || message.headers.get("Subject"),
      date: parsed.date || message.headers.get("Date"),
      routingKey: deriveRoutingKey(recipient),
      textBody: typeof parsed.text === "string" ? parsed.text : "",
      htmlBody: typeof parsed.html === "string" ? parsed.html : "",
      headers: Array.from(message.headers.entries()).map(([name, value]) => ({
        name,
        value,
      })),
      attachments: (parsed.attachments ?? []).map((attachment: Record<string, unknown>) => {
        const normalizedAttachment = attachment as {
          content?: unknown;
          contentType?: string;
          filename?: string;
          mimeType?: string;
        };
        const normalizedContent = normalizeBinaryContent(normalizedAttachment.content);

        return {
          filename: normalizedAttachment.filename || null,
          contentType:
            typeof normalizedAttachment.mimeType === "string"
              ? normalizedAttachment.mimeType
              : typeof normalizedAttachment.contentType === "string"
                ? normalizedAttachment.contentType
                : null,
          contentLength: normalizedContent.contentLength,
          contentBase64: normalizedContent.contentBase64,
        };
      }),
    };

    const response = await fetch(env.INGEST_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-email-ingest-secret": env.EMAIL_INGEST_SHARED_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `DraftBridge ingest failed with ${response.status}: ${await response.text()}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;
