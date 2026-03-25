import type {
  ParseStatus,
  PurchaseOrderStatus,
  SourceDocumentKind,
} from "@prisma/client";
import db from "../db.server";

const DEFAULT_WINDOW_DAYS = 7;
const DRIFT_MIN_SAMPLE = 2;

type ReportOrder = {
  id: string;
  status: PurchaseOrderStatus;
  createdAt: Date;
  finalConfidence: number;
  extractedConfidence: number;
  sourceKind: SourceDocumentKind | null;
  parseStatus: ParseStatus | null;
  senderLabel: string;
  validationIssues: Array<{
    code: string;
    blocking: boolean;
  }>;
};

export interface PeriodSummary {
  orderCount: number;
  autoDraftedCount: number;
  reviewCount: number;
  failedCount: number;
  duplicateCount: number;
  averageFinalConfidence: number;
  averageExtractedConfidence: number;
  straightThroughRate: number;
  reviewRate: number;
  failureRate: number;
}

export interface ValidationIssueBreakdown {
  code: string;
  totalCount: number;
  blockingCount: number;
  orderCount: number;
  shareOfOrders: number;
}

export interface ParseStatusBreakdown {
  key: string;
  sourceKind: SourceDocumentKind | "UNKNOWN";
  parseStatus: ParseStatus | "UNKNOWN";
  count: number;
  shareOfOrders: number;
}

export interface BreakdownRow {
  label: string;
  current: PeriodSummary;
  prior: PeriodSummary;
}

export interface DriftAlert {
  dimension: "SOURCE_KIND" | "SENDER";
  label: string;
  metric: "straightThroughRate" | "reviewRate" | "failureRate" | "averageFinalConfidence";
  currentValue: number;
  priorValue: number;
  deltaValue: number;
  currentCount: number;
  priorCount: number;
  severity: "high" | "medium";
}

export interface QueueAgingBucket {
  label: string;
  count: number;
}

export interface OperationalReport {
  generatedAt: string;
  windowDays: number;
  currentWindowStart: string;
  priorWindowStart: string;
  current: PeriodSummary;
  prior: PeriodSummary;
  validationIssues: ValidationIssueBreakdown[];
  parseStatusBreakdown: ParseStatusBreakdown[];
  sourceKindBreakdown: BreakdownRow[];
  senderBreakdown: BreakdownRow[];
  driftAlerts: DriftAlert[];
  queueAging: QueueAgingBucket[];
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(count: number, total: number) {
  if (total === 0) {
    return 0;
  }

  return count / total;
}

function roundNumber(value: number, digits = 4) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function isReviewStatus(status: PurchaseOrderStatus) {
  return status === "OPS_REVIEW" || status === "DUPLICATE";
}

export function summarizeOrders(orders: ReportOrder[]): PeriodSummary {
  const orderCount = orders.length;
  const autoDraftedCount = orders.filter((order) => order.status === "AUTO_DRAFTED").length;
  const duplicateCount = orders.filter((order) => order.status === "DUPLICATE").length;
  const reviewCount = orders.filter((order) => isReviewStatus(order.status)).length;
  const failedCount = orders.filter((order) => order.status === "FAILED").length;

  return {
    orderCount,
    autoDraftedCount,
    reviewCount,
    failedCount,
    duplicateCount,
    averageFinalConfidence: roundNumber(
      average(orders.map((order) => order.finalConfidence)),
    ),
    averageExtractedConfidence: roundNumber(
      average(orders.map((order) => order.extractedConfidence)),
    ),
    straightThroughRate: roundNumber(rate(autoDraftedCount, orderCount)),
    reviewRate: roundNumber(rate(reviewCount, orderCount)),
    failureRate: roundNumber(rate(failedCount, orderCount)),
  };
}

function summarizeByDimension(
  currentOrders: ReportOrder[],
  priorOrders: ReportOrder[],
  selector: (order: ReportOrder) => string,
) {
  const labels = new Set<string>();

  for (const order of currentOrders) {
    labels.add(selector(order));
  }

  for (const order of priorOrders) {
    labels.add(selector(order));
  }

  return [...labels]
    .map((label) => {
      const current = summarizeOrders(currentOrders.filter((order) => selector(order) === label));
      const prior = summarizeOrders(priorOrders.filter((order) => selector(order) === label));

      return {
        label,
        current,
        prior,
      } satisfies BreakdownRow;
    })
    .filter((row) => row.current.orderCount > 0 || row.prior.orderCount > 0)
    .sort((left, right) => right.current.orderCount - left.current.orderCount);
}

export function buildValidationIssueBreakdown(currentOrders: ReportOrder[]) {
  const ordersByCode = new Map<
    string,
    {
      totalCount: number;
      blockingCount: number;
      orderIds: Set<string>;
    }
  >();

  for (const order of currentOrders) {
    for (const issue of order.validationIssues) {
      const existing = ordersByCode.get(issue.code) ?? {
        totalCount: 0,
        blockingCount: 0,
        orderIds: new Set<string>(),
      };
      existing.totalCount += 1;
      if (issue.blocking) {
        existing.blockingCount += 1;
      }
      existing.orderIds.add(order.id);
      ordersByCode.set(issue.code, existing);
    }
  }

  return [...ordersByCode.entries()]
    .map(([code, value]) => ({
      code,
      totalCount: value.totalCount,
      blockingCount: value.blockingCount,
      orderCount: value.orderIds.size,
      shareOfOrders: roundNumber(rate(value.orderIds.size, currentOrders.length)),
    }) satisfies ValidationIssueBreakdown)
    .sort((left, right) => right.orderCount - left.orderCount || right.totalCount - left.totalCount)
    .slice(0, 8);
}

export function buildParseStatusBreakdown(currentOrders: ReportOrder[]) {
  const counts = new Map<string, number>();

  for (const order of currentOrders) {
    const sourceKind = order.sourceKind ?? "UNKNOWN";
    const parseStatus = order.parseStatus ?? "UNKNOWN";
    const key = `${sourceKind}:${parseStatus}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceKind, parseStatus] = key.split(":");
      return {
        key,
        sourceKind: sourceKind as SourceDocumentKind | "UNKNOWN",
        parseStatus: parseStatus as ParseStatus | "UNKNOWN",
        count,
        shareOfOrders: roundNumber(rate(count, currentOrders.length)),
      } satisfies ParseStatusBreakdown;
    })
    .sort((left, right) => right.count - left.count);
}

export function buildDriftAlerts(input: {
  sourceKindBreakdown: BreakdownRow[];
  senderBreakdown: BreakdownRow[];
}) {
  const alerts: DriftAlert[] = [];

  const evaluate = (
    dimension: DriftAlert["dimension"],
    rows: BreakdownRow[],
  ) => {
    for (const row of rows) {
      if (
        row.current.orderCount < DRIFT_MIN_SAMPLE ||
        row.prior.orderCount < DRIFT_MIN_SAMPLE
      ) {
        continue;
      }

      const checks: Array<{
        metric: DriftAlert["metric"];
        currentValue: number;
        priorValue: number;
        threshold: number;
        direction: "up" | "down";
      }> = [
        {
          metric: "straightThroughRate",
          currentValue: row.current.straightThroughRate,
          priorValue: row.prior.straightThroughRate,
          threshold: 0.2,
          direction: "down",
        },
        {
          metric: "reviewRate",
          currentValue: row.current.reviewRate,
          priorValue: row.prior.reviewRate,
          threshold: 0.2,
          direction: "up",
        },
        {
          metric: "failureRate",
          currentValue: row.current.failureRate,
          priorValue: row.prior.failureRate,
          threshold: 0.1,
          direction: "up",
        },
        {
          metric: "averageFinalConfidence",
          currentValue: row.current.averageFinalConfidence,
          priorValue: row.prior.averageFinalConfidence,
          threshold: 0.08,
          direction: "down",
        },
      ];

      for (const check of checks) {
        const deltaValue = roundNumber(check.currentValue - check.priorValue);
        const crossedThreshold =
          check.direction === "up"
            ? deltaValue >= check.threshold
            : deltaValue <= -check.threshold;

        if (!crossedThreshold) {
          continue;
        }

        alerts.push({
          dimension,
          label: row.label,
          metric: check.metric,
          currentValue: check.currentValue,
          priorValue: check.priorValue,
          deltaValue,
          currentCount: row.current.orderCount,
          priorCount: row.prior.orderCount,
          severity: Math.abs(deltaValue) >= check.threshold * 1.5 ? "high" : "medium",
        });
      }
    }
  };

  evaluate("SOURCE_KIND", input.sourceKindBreakdown);
  evaluate("SENDER", input.senderBreakdown);

  return alerts.sort((left, right) => Math.abs(right.deltaValue) - Math.abs(left.deltaValue));
}

function buildQueueAgingBuckets(openOpsCases: Array<{ createdAt: Date }>) {
  const now = Date.now();
  const buckets: Array<QueueAgingBucket> = [
    { label: "0-24h", count: 0 },
    { label: "1-3d", count: 0 },
    { label: "3+d", count: 0 },
  ];

  for (const opsCase of openOpsCases) {
    const ageHours = (now - opsCase.createdAt.getTime()) / (1000 * 60 * 60);

    if (ageHours < 24) {
      buckets[0]!.count += 1;
    } else if (ageHours < 72) {
      buckets[1]!.count += 1;
    } else {
      buckets[2]!.count += 1;
    }
  }

  return buckets;
}

function formatPeriodRange(end: Date, windowDays: number) {
  const start = new Date(end);
  start.setDate(start.getDate() - windowDays);
  return start;
}

export async function getOperationalReport(input: {
  shopId: string;
  windowDays?: number;
}) {
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const generatedAt = new Date();
  const currentWindowStart = formatPeriodRange(generatedAt, windowDays);
  const priorWindowStart = formatPeriodRange(currentWindowStart, windowDays);

  const [orders, openOpsCases] = await Promise.all([
    db.purchaseOrder.findMany({
      where: {
        shopId: input.shopId,
        createdAt: {
          gte: priorWindowStart,
        },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        createdAt: true,
        finalConfidence: true,
        extractedConfidence: true,
        senderProfile: {
          select: {
            senderEmail: true,
            senderDomain: true,
          },
        },
        sourceDocument: {
          select: {
            kind: true,
            parseStatus: true,
          },
        },
        validationIssues: {
          select: {
            code: true,
            blocking: true,
          },
        },
      },
    }),
    db.opsCase.findMany({
      where: {
        shopId: input.shopId,
        status: {
          in: ["OPEN", "IN_PROGRESS", "WAITING_ON_MERCHANT"],
        },
      },
      select: {
        createdAt: true,
      },
    }),
  ]);

  const reportOrders = orders.map((order) => ({
    id: order.id,
    status: order.status,
    createdAt: order.createdAt,
    finalConfidence: order.finalConfidence,
    extractedConfidence: order.extractedConfidence,
    sourceKind: order.sourceDocument?.kind ?? null,
    parseStatus: order.sourceDocument?.parseStatus ?? null,
    senderLabel:
      order.senderProfile?.senderEmail ??
      order.senderProfile?.senderDomain ??
      "Unknown sender",
    validationIssues: order.validationIssues,
  })) satisfies ReportOrder[];

  const currentOrders = reportOrders.filter((order) => order.createdAt >= currentWindowStart);
  const priorOrders = reportOrders.filter(
    (order) => order.createdAt >= priorWindowStart && order.createdAt < currentWindowStart,
  );

  const sourceKindBreakdown = summarizeByDimension(
    currentOrders,
    priorOrders,
    (order) => order.sourceKind ?? "UNKNOWN",
  );
  const senderBreakdown = summarizeByDimension(
    currentOrders,
    priorOrders,
    (order) => order.senderLabel,
  ).slice(0, 8);

  return {
    generatedAt: generatedAt.toISOString(),
    windowDays,
    currentWindowStart: currentWindowStart.toISOString(),
    priorWindowStart: priorWindowStart.toISOString(),
    current: summarizeOrders(currentOrders),
    prior: summarizeOrders(priorOrders),
    validationIssues: buildValidationIssueBreakdown(currentOrders),
    parseStatusBreakdown: buildParseStatusBreakdown(currentOrders),
    sourceKindBreakdown,
    senderBreakdown,
    driftAlerts: buildDriftAlerts({
      sourceKindBreakdown,
      senderBreakdown,
    }).slice(0, 8),
    queueAging: buildQueueAgingBuckets(openOpsCases),
  } satisfies OperationalReport;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function signedDelta(value: number, format: (input: number) => string) {
  if (value === 0) {
    return format(0);
  }

  return `${value > 0 ? "+" : ""}${format(value)}`;
}

export function formatOperationalReportMarkdown(report: OperationalReport) {
  const lines: string[] = [];

  lines.push(`# DraftBridge Operational Report`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: last ${report.windowDays} days vs prior ${report.windowDays} days`);
  lines.push("");
  lines.push("## Funnel");
  lines.push(
    `- Received orders: ${report.current.orderCount} (${signedDelta(
      report.current.orderCount - report.prior.orderCount,
      (value) => String(value),
    )} vs prior)`,
  );
  lines.push(
    `- Straight-through rate: ${percent(report.current.straightThroughRate)} (${signedDelta(
      report.current.straightThroughRate - report.prior.straightThroughRate,
      percent,
    )} vs prior)`,
  );
  lines.push(
    `- Review rate: ${percent(report.current.reviewRate)} (${signedDelta(
      report.current.reviewRate - report.prior.reviewRate,
      percent,
    )} vs prior)`,
  );
  lines.push(
    `- Failure rate: ${percent(report.current.failureRate)} (${signedDelta(
      report.current.failureRate - report.prior.failureRate,
      percent,
    )} vs prior)`,
  );
  lines.push("");
  lines.push("## Drift alerts");

  if (report.driftAlerts.length === 0) {
    lines.push("- No material drift alerts.");
  } else {
    for (const alert of report.driftAlerts) {
      lines.push(
        `- [${alert.severity.toUpperCase()}] ${alert.dimension} ${alert.label}: ${alert.metric} ${signedDelta(
          alert.deltaValue,
          percent,
        )} (${percent(alert.priorValue)} -> ${percent(alert.currentValue)})`,
      );
    }
  }

  lines.push("");
  lines.push("## Top validation issues");

  if (report.validationIssues.length === 0) {
    lines.push("- No validation issues in the current window.");
  } else {
    for (const issue of report.validationIssues) {
      lines.push(
        `- ${issue.code}: ${issue.orderCount} orders, ${issue.totalCount} total occurrences, ${percent(
          issue.shareOfOrders,
        )} of current orders`,
      );
    }
  }

  return lines.join("\n");
}
