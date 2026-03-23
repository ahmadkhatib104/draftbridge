import type { AuditActorType, AuditEntityType, Prisma } from "@prisma/client";
import db from "../db.server";

interface CreateAuditEventInput {
  shopId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  summary: string;
  actorType?: AuditActorType;
  actorUserId?: string | null;
  purchaseOrderId?: string | null;
  opsCaseId?: string | null;
  metadata?: Prisma.JsonValue | null;
}

export async function createAuditEvent(input: CreateAuditEventInput) {
  return db.auditEvent.create({
    data: {
      shopId: input.shopId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary,
      actorType: input.actorType ?? "SYSTEM",
      actorUserId: input.actorUserId ?? undefined,
      purchaseOrderId: input.purchaseOrderId ?? undefined,
      opsCaseId: input.opsCaseId ?? undefined,
      metadata: input.metadata ?? undefined,
    },
  });
}
