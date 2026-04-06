import { describe, expect, it } from "vitest";
import {
  buildBillingGateRedirectPath,
  evaluateBillingGate,
} from "./billing.server";

describe("billing gate", () => {
  it("allows active paid plans", () => {
    expect(
      evaluateBillingGate({
        plan: "GROWTH",
        status: "ACTIVE",
        usageCount: 500,
      }),
    ).toMatchObject({
      blocked: false,
      reason: null,
      plan: "GROWTH",
      status: "ACTIVE",
    });
  });

  it("allows the free success allowance before billing is required", () => {
    expect(
      evaluateBillingGate({
        plan: "FREE",
        status: "INACTIVE",
        usageCount: 2,
      }),
    ).toMatchObject({
      blocked: false,
      reason: null,
      usageCount: 2,
      freeSuccessLimit: 3,
    });
  });

  it("blocks free installs after the free allowance is used", () => {
    expect(
      evaluateBillingGate({
        plan: "FREE",
        status: "INACTIVE",
        usageCount: 3,
      }),
    ).toMatchObject({
      blocked: true,
      reason: "FREE_LIMIT_REACHED",
    });
  });

  it("blocks inactive paid installs after trial access is gone", () => {
    expect(
      evaluateBillingGate({
        plan: "GROWTH",
        status: "CANCELED",
        usageCount: 12,
      }),
    ).toMatchObject({
      blocked: true,
      reason: "SUBSCRIPTION_REQUIRED",
      plan: "GROWTH",
      status: "CANCELED",
    });
  });

  it("builds a billing redirect that preserves the original path", () => {
    expect(
      buildBillingGateRedirectPath({
        currentPath: "/app/orders/123?foo=bar",
        reason: "FREE_LIMIT_REACHED",
      }),
    ).toBe(
      "/app/billing?returnPath=%2Fapp%2Forders%2F123%3Ffoo%3Dbar&gate=FREE_LIMIT_REACHED",
    );
  });
});
