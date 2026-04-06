import { describe, expect, it } from "vitest"

import {
  detectShopify,
  discoverCandidatePageUrls,
  extractDuckDuckGoResultUrls,
  scoreLeadAudit,
} from "./outbound-research"

describe("outbound research helpers", () => {
  it("extracts real result URLs from DuckDuckGo redirect links", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpages%2Fwholesale">Example</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsecond.example%2Ftrade">Second</a>
      </div>
    `

    expect(extractDuckDuckGoResultUrls(html)).toEqual([
      "https://example.com/pages/wholesale",
      "https://second.example/trade",
    ])
  })

  it("discovers likely wholesale pages from links and known paths", () => {
    const urls = discoverCandidatePageUrls(
      "https://merchant.example",
      `
        <a href="/pages/wholesale">Wholesale</a>
        <a href="/trade">Trade Accounts</a>
      `,
    )

    expect(urls).toContain("https://merchant.example/pages/wholesale")
    expect(urls).toContain("https://merchant.example/trade")
  })

  it("detects Shopify storefront markers", () => {
    expect(detectShopify('<script src="https://cdn.shopify.com/s/files/app.js"></script>')).toBe(true)
    expect(detectShopify("<html><body>Plain site</body></html>")).toBe(false)
  })

  it("scores a strong-fit Shopify wholesale lead", () => {
    const audit = scoreLeadAudit({
      domain: "merchant.example",
      homepageUrl: "https://merchant.example",
      homepageHtml: `
        <html>
          <head>
            <title>Bright Snacks Wholesale</title>
            <script src="https://cdn.shopify.com/s/files/app.js"></script>
          </head>
          <body>
            <a href="/pages/wholesale">Wholesale</a>
            <p>Wholesale snacks for retailers and stockists.</p>
            <p>Email wholesale@merchant.example for line sheet access.</p>
          </body>
        </html>
      `,
      candidatePages: [
        {
          url: "https://merchant.example/pages/wholesale",
          html: "<h1>Wholesale</h1><p>Trade account for retailers and bulk order inquiries.</p>",
        },
      ],
    })

    expect(audit.verdict).toBe("Strong fit")
    expect(audit.shopifyDetected).toBe(true)
    expect(audit.wholesalePageUrl).toBe("https://merchant.example/pages/wholesale")
    expect(audit.contactEmail).toBe("wholesale@merchant.example")
    expect(audit.vertical).toBe("Food & beverage")
    expect(audit.score).toBeGreaterThanOrEqual(65)
  })

  it("disqualifies publicly enterprise-leaning ERP footprints", () => {
    const audit = scoreLeadAudit({
      domain: "merchant.example",
      homepageUrl: "https://merchant.example",
      homepageHtml: `
        <html>
          <head>
            <title>Merchant</title>
            <script src="https://cdn.shopify.com/s/files/app.js"></script>
          </head>
          <body>
            <p>Wholesale portal with NetSuite and EDI automation.</p>
          </body>
        </html>
      `,
    })

    expect(audit.verdict).toBe("Disqualify")
    expect(audit.erpDetected).toBe(true)
  })
})
