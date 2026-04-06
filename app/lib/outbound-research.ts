const WHOLESALE_KEYWORDS = [
  "wholesale",
  "trade account",
  "trade program",
  "b2b",
  "retailer",
  "retailers",
  "stockist",
  "stockists",
  "reseller",
  "line sheet",
  "bulk order",
  "case pack",
  "wholesale inquiry",
  "wholesale enquiries",
  "request a wholesale account",
  "become a stockist",
]

const ERP_KEYWORDS = [
  "netsuite",
  "sap",
  "sps commerce",
  "edi",
  "oracle",
  "microsoft dynamics",
  "infor",
]

const VERTICAL_KEYWORDS: Array<{ label: string; keywords: string[] }> = [
  { label: "Food & beverage", keywords: ["food", "beverage", "snack", "coffee", "tea"] },
  { label: "Beauty", keywords: ["beauty", "skincare", "cosmetic", "haircare", "fragrance"] },
  { label: "Apparel", keywords: ["apparel", "clothing", "fashion", "garment", "wear"] },
  { label: "Home goods", keywords: ["home decor", "kitchen", "decor", "houseware", "furniture"] },
  { label: "Supplements", keywords: ["supplement", "wellness", "vitamin", "protein", "nutrition"] },
  { label: "Pet", keywords: ["pet", "dog", "cat", "animal"] },
]

const NON_MERCHANT_KEYWORDS = [
  "agency",
  "partner",
  "consulting",
  "developer",
  "community",
  "shopify app",
  "app for shopify",
  "software",
]

const COMMON_WHOLESALE_PATHS = [
  "/wholesale",
  "/pages/wholesale",
  "/trade",
  "/pages/trade",
  "/b2b",
  "/pages/b2b",
  "/wholesale-login",
  "/pages/wholesale-login",
  "/account/register?view=wholesale",
]

export type LeadAuditInput = {
  domain: string
  homepageUrl: string
  homepageHtml: string
  candidatePages?: Array<{
    url: string
    html: string
  }>
}

export type LeadAuditResult = {
  companyName: string
  shopifyDetected: boolean
  wholesalePageUrl: string | null
  wholesaleSignalCount: number
  contactEmail: string | null
  vertical: string | null
  erpDetected: boolean
  score: number
  verdict: "Strong fit" | "Review" | "Disqualify"
  reasons: string[]
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values))
}

function escapeForRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function normalizeLeadUrl(value: string) {
  const trimmed = value.trim()

  if (!trimmed) {
    return null
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withScheme)

    if (!/^https?:$/i.test(url.protocol)) {
      return null
    }

    url.hash = ""
    url.search = ""
    return url
  } catch {
    return null
  }
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
  }

function resolveDuckDuckGoHref(rawHref: string) {
  const href = decodeHtmlAttribute(rawHref)

  try {
    const redirectUrl = new URL(href, "https://duckduckgo.com")
    const target = redirectUrl.searchParams.get("uddg")

    if (target) {
      return decodeURIComponent(target)
    }

    if (/^https?:\/\//i.test(redirectUrl.toString())) {
      return redirectUrl.toString()
    }
  } catch {
    return null
  }

  return null
}

export function extractDuckDuckGoResultUrls(html: string) {
  const results: string[] = []
  const linkPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi

  for (const match of html.matchAll(linkPattern)) {
    const resolved = resolveDuckDuckGoHref(match[1] ?? "")

    if (!resolved) {
      continue
    }

    const normalized = normalizeLeadUrl(resolved)

    if (!normalized) {
      continue
    }

    if (normalized.hostname.includes("duckduckgo.com")) {
      continue
    }

    results.push(normalized.toString())
  }

  return unique(results)
}

export function inferCompanyName(html: string, domain: string) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
  const ogSiteName = html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i)
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const candidate = ogSiteName?.[1] ?? titleMatch?.[1] ?? (h1Match ? stripHtml(h1Match[1] ?? "") : "")

  if (candidate) {
    return candidate
      .replace(/\s*\|\s*shopify.*$/i, "")
      .replace(/\s*\|\s*wholesale.*$/i, "")
      .replace(/\s*-\s*shopify.*$/i, "")
      .trim()
  }

  return domain.replace(/^www\./i, "")
}

export function detectShopify(html: string) {
  const markers = [
    "cdn.shopify.com",
    "myshopify.com",
    "shopify-section",
    "Shopify.theme",
    "shopify-payment-button",
    "x-shopify-stage",
  ]

  const lower = html.toLowerCase()
  return markers.some((marker) => lower.includes(marker.toLowerCase()))
}

export function discoverCandidatePageUrls(baseUrl: string, homepageHtml: string) {
  const discovered: string[] = []
  const base = new URL(baseUrl)

  for (const path of COMMON_WHOLESALE_PATHS) {
    discovered.push(new URL(path, base).toString())
  }

  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

  for (const match of homepageHtml.matchAll(anchorPattern)) {
    const href = decodeHtmlAttribute(match[1] ?? "")
    const anchorText = stripHtml(match[2] ?? "").toLowerCase()
    const hrefLower = href.toLowerCase()

    if (!WHOLESALE_KEYWORDS.some((keyword) => anchorText.includes(keyword) || hrefLower.includes(keyword))) {
      continue
    }

    try {
      const url = new URL(href, base)

      if (/^https?:$/i.test(url.protocol)) {
        discovered.push(url.toString())
      }
    } catch {
      continue
    }
  }

  return unique(discovered).slice(0, 8)
}

function extractEmails(html: string) {
  const emails = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []

  return unique(
    emails
      .map((value) => value.toLowerCase())
      .filter((value) => !/\.(png|jpg|jpeg|webp|svg|gif|css|js|ico)$/.test(value)),
  )
}

function containsKeyword(text: string, keyword: string) {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeForRegex(keyword.toLowerCase())}($|[^a-z0-9])`, "i")
  return pattern.test(text)
}

function countMatchedKeywords(text: string, keywords: string[]) {
  return keywords.filter((keyword) => containsKeyword(text, keyword)).length
}

export function scoreLeadAudit(input: LeadAuditInput): LeadAuditResult {
  const candidatePages = input.candidatePages ?? []
  const allPages = [{ url: input.homepageUrl, html: input.homepageHtml }, ...candidatePages]
  const pageTexts = allPages.map((page) => stripHtml(page.html).toLowerCase())
  const combinedText = pageTexts.join(" ")
  const shopifyDetected = detectShopify(input.homepageHtml)
  const wholesaleSignalCount = countMatchedKeywords(combinedText, WHOLESALE_KEYWORDS)
  const erpDetected = ERP_KEYWORDS.some((keyword) => containsKeyword(combinedText, keyword))
  const nonMerchantDetected = NON_MERCHANT_KEYWORDS.some((keyword) => containsKeyword(combinedText, keyword))
  const wholesalePage =
    candidatePages.find((page) => WHOLESALE_KEYWORDS.some((keyword) => page.url.toLowerCase().includes(keyword))) ??
    candidatePages.find((page) => WHOLESALE_KEYWORDS.some((keyword) => containsKeyword(stripHtml(page.html).toLowerCase(), keyword))) ??
    null
  const contactEmail =
    extractEmails(input.homepageHtml).find((email) => !email.startsWith("noreply@")) ??
    extractEmails(candidatePages.map((page) => page.html).join(" ")).find((email) => !email.startsWith("noreply@")) ??
    null
  const vertical =
    VERTICAL_KEYWORDS.find((entry) =>
      entry.keywords.some((keyword) => combinedText.includes(keyword)),
    )?.label ?? null

  const reasons: string[] = []
  let score = 0

  if (shopifyDetected) {
    score += 30
    reasons.push("Shopify storefront detected")
  } else {
    reasons.push("Shopify storefront not confirmed")
  }

  if (wholesalePage) {
    score += 25
    reasons.push("Dedicated wholesale or trade page found")
  }

  if (wholesaleSignalCount >= 4) {
    score += 20
    reasons.push("Strong wholesale wording on public pages")
  } else if (wholesaleSignalCount >= 2) {
    score += 12
    reasons.push("Moderate wholesale wording on public pages")
  } else if (wholesaleSignalCount >= 1) {
    score += 6
    reasons.push("Some wholesale wording on public pages")
  }

  if (contactEmail) {
    score += 10
    reasons.push("Public contact email found")
  }

  if (vertical) {
    score += 10
    reasons.push(`Fits target vertical: ${vertical}`)
  }

  if (nonMerchantDetected) {
    score -= 20
    reasons.push("Looks like a vendor, agency, or ecosystem site")
  }

  if (erpDetected) {
    score -= 25
    reasons.push("ERP or EDI footprint detected publicly")
  } else {
    score += 5
    reasons.push("No obvious ERP or EDI footprint found")
  }

  score = Math.max(0, Math.min(100, score))

  let verdict: LeadAuditResult["verdict"] = "Review"

  if (erpDetected || nonMerchantDetected) {
    verdict = "Disqualify"
  } else if (shopifyDetected && (wholesalePage || wholesaleSignalCount >= 2) && score >= 65) {
    verdict = "Strong fit"
  } else if (!shopifyDetected && wholesaleSignalCount === 0) {
    verdict = "Disqualify"
  }

  return {
    companyName: inferCompanyName(input.homepageHtml, input.domain),
    shopifyDetected,
    wholesalePageUrl: wholesalePage?.url ?? null,
    wholesaleSignalCount,
    contactEmail,
    vertical,
    erpDetected,
    score,
    verdict,
    reasons,
  }
}
