import { randomBytes } from "node:crypto";
import { MailboxProvider, Prisma } from "@prisma/client";
import db from "../db.server";
import { getIncludedUsageLimit } from "../lib/billing";
import { requireEmailRoutingDomain } from "../lib/env.server";
import { createAuditEvent } from "./audit.server";
import { upsertBillingStateSafely } from "./billing.server";

function normalizeRoutingKey(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/\.myshopify\.com$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "shop"
  );
}

function buildForwardingAddress(routingKey: string) {
  return `${routingKey}@${requireEmailRoutingDomain()}`;
}

async function createPrimaryMailbox(shopId: string, shopDomain: string) {
  let routingKey = normalizeRoutingKey(shopDomain);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await db.mailbox.create({
        data: {
          shopId,
          provider: MailboxProvider.CLOUDFLARE_EMAIL_ROUTING,
          routingKey,
          forwardingAddress: buildForwardingAddress(routingKey),
          inboundDomain: requireEmailRoutingDomain(),
        },
      });
    } catch (error) {
      const isUniqueConflict =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";

      if (!isUniqueConflict) {
        throw error;
      }

      routingKey = `${normalizeRoutingKey(shopDomain)}-${randomBytes(2).toString("hex")}`;
    }
  }

  throw new Error(`Could not create a unique mailbox for ${shopDomain}.`);
}

async function syncPrimaryMailboxDomain(shopId: string, mailboxId: string, routingKey: string) {
  const expectedInboundDomain = requireEmailRoutingDomain();
  const expectedForwardingAddress = buildForwardingAddress(routingKey);

  const mailbox = await db.mailbox.update({
    where: { id: mailboxId },
    data: {
      inboundDomain: expectedInboundDomain,
      forwardingAddress: expectedForwardingAddress,
    },
  });

  await createAuditEvent({
    shopId,
    entityType: "MAILBOX",
    entityId: mailbox.id,
    action: "MAILBOX_UPDATED",
    summary: `Updated forwarding mailbox to ${mailbox.forwardingAddress}.`,
    metadata: {
      forwardingAddress: mailbox.forwardingAddress,
      inboundDomain: mailbox.inboundDomain,
    },
  });

  return mailbox;
}

export async function ensureShopRecord(
  shopDomain: string,
  sessionEmail?: string | null,
  sessionUserId?: string | bigint | null,
  sessionUserName?: { firstName?: string | null; lastName?: string | null },
) {
  const shop = await db.shop.upsert({
    where: { shopDomain },
    update: {
      email: sessionEmail ?? undefined,
      installedAt: new Date(),
    },
    create: {
      shopDomain,
      email: sessionEmail ?? undefined,
      installedAt: new Date(),
    },
  });

  let mailbox = await db.mailbox.findFirst({
    where: { shopId: shop.id, isPrimary: true },
    orderBy: { createdAt: "asc" },
  });

  if (!mailbox) {
    mailbox = await createPrimaryMailbox(shop.id, shopDomain);
    await db.shop.update({
      where: { id: shop.id },
      data: { onboardingStatus: "MAILBOX_CREATED" },
    });

    await createAuditEvent({
      shopId: shop.id,
      entityType: "MAILBOX",
      entityId: mailbox.id,
      action: "MAILBOX_CREATED",
      summary: `Created forwarding mailbox ${mailbox.forwardingAddress}.`,
      metadata: { forwardingAddress: mailbox.forwardingAddress },
    });
  } else {
    const expectedInboundDomain = requireEmailRoutingDomain();
    const expectedForwardingAddress = buildForwardingAddress(mailbox.routingKey);

    if (
      mailbox.provider === MailboxProvider.CLOUDFLARE_EMAIL_ROUTING &&
      (mailbox.inboundDomain !== expectedInboundDomain ||
        mailbox.forwardingAddress !== expectedForwardingAddress)
    ) {
      mailbox = await syncPrimaryMailboxDomain(shop.id, mailbox.id, mailbox.routingKey);
    }
  }

  await upsertBillingStateSafely({
    shopId: shop.id,
    update: {},
    create: {
      plan: "FREE",
      status: "INACTIVE",
      includedUsageLimit: getIncludedUsageLimit("FREE"),
    },
  });

  if (sessionEmail) {
    await db.user.upsert({
      where: {
        shopId_email: {
          shopId: shop.id,
          email: sessionEmail,
        },
      },
      update: {
        shopifyUserId:
          sessionUserId === null || sessionUserId === undefined
            ? undefined
            : String(sessionUserId),
        firstName: sessionUserName?.firstName ?? undefined,
        lastName: sessionUserName?.lastName ?? undefined,
        lastSeenAt: new Date(),
      },
      create: {
        shopId: shop.id,
        email: sessionEmail,
        shopifyUserId:
          sessionUserId === null || sessionUserId === undefined
            ? undefined
            : String(sessionUserId),
        firstName: sessionUserName?.firstName ?? undefined,
        lastName: sessionUserName?.lastName ?? undefined,
        lastSeenAt: new Date(),
      },
    });
  }

  const bootstrapEvent = await db.auditEvent.findFirst({
    where: {
      shopId: shop.id,
      action: "SHOP_BOOTSTRAPPED",
    },
    select: { id: true },
  });

  if (!bootstrapEvent) {
    await createAuditEvent({
      shopId: shop.id,
      entityType: "SHOP",
      entityId: shop.id,
      action: "SHOP_BOOTSTRAPPED",
      summary: `Created local DraftBridge records for ${shopDomain}.`,
      metadata: { shopDomain },
    });
  }

  return db.shop.findUniqueOrThrow({
    where: { id: shop.id },
    include: {
      billingState: true,
      mailboxes: {
        where: { isPrimary: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
}

export async function getPrimaryMailbox(shopId: string) {
  return db.mailbox.findFirstOrThrow({
    where: { shopId, isPrimary: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getDashboardSnapshot(shopId: string) {
  const [
    recentOrders,
    orderCounts,
    openOpsCaseCount,
    latestMailbox,
    latestAuditEvents,
  ] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        lineItems: {
          orderBy: { lineNumber: "asc" },
          take: 3,
        },
        draftOrderSync: true,
      },
    }),
    db.purchaseOrder.groupBy({
      by: ["status"],
      where: { shopId },
      _count: { _all: true },
    }),
    db.opsCase.count({
      where: {
        shopId,
        status: {
          in: ["OPEN", "IN_PROGRESS", "WAITING_ON_MERCHANT"],
        },
      },
    }),
    getPrimaryMailbox(shopId),
    db.auditEvent.findMany({
      where: { shopId },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);

  return {
    recentOrders,
    orderCounts,
    openOpsCaseCount,
    mailbox: latestMailbox,
    auditEvents: latestAuditEvents,
  };
}
