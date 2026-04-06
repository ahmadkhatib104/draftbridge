import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, extname, resolve } from "node:path"

import {
  discoverCandidatePageUrls,
  extractDuckDuckGoResultUrls,
  normalizeLeadUrl,
  scoreLeadAudit,
} from "../app/lib/outbound-research"

type Args = {
  inputPath: string | null
  outputPath: string
  queries: string[]
  limitPerQuery: number
  concurrency: number
  timeoutMs: number
}

type SeedCandidate = {
  domain: string
  homepageUrl: string
  sourceQueries: string[]
}

type AuditedLead = {
  domain: string
  homepageUrl: string
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
  sourceQueries: string[]
}

const DEFAULT_EXCLUDED_DOMAINS = [
  "shopify.com",
  "community.shopify.com",
  "help.shopify.com",
  "apps.shopify.com",
]

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    inputPath: null,
    outputPath: "tmp/outbound-targets.csv",
    queries: [],
    limitPerQuery: 20,
    concurrency: 4,
    timeoutMs: 15000,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]

    if ((value === "--input" || value === "-i") && argv[index + 1]) {
      parsed.inputPath = argv[index + 1]!
      index += 1
      continue
    }

    if ((value === "--output" || value === "-o") && argv[index + 1]) {
      parsed.outputPath = argv[index + 1]!
      index += 1
      continue
    }

    if ((value === "--query" || value === "-q") && argv[index + 1]) {
      parsed.queries.push(argv[index + 1]!)
      index += 1
      continue
    }

    if ((value === "--limit" || value === "-l") && argv[index + 1]) {
      parsed.limitPerQuery = Number(argv[index + 1] ?? parsed.limitPerQuery) || parsed.limitPerQuery
      index += 1
      continue
    }

    if ((value === "--concurrency" || value === "-c") && argv[index + 1]) {
      parsed.concurrency = Number(argv[index + 1] ?? parsed.concurrency) || parsed.concurrency
      index += 1
      continue
    }

    if ((value === "--timeout-ms" || value === "-t") && argv[index + 1]) {
      parsed.timeoutMs = Number(argv[index + 1] ?? parsed.timeoutMs) || parsed.timeoutMs
      index += 1
    }
  }

  return parsed
}

function csvEscape(value: string | number | boolean | null) {
  const stringValue = value === null ? "" : String(value)
  const escaped = stringValue.replaceAll("\"", "\"\"")
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped
}

function normalizeDomain(hostname: string) {
  return hostname.replace(/^www\./i, "").toLowerCase()
}

function joinUnique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

async function fetchText(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`)
    }

    return {
      finalUrl: response.url,
      text: await response.text(),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchHomepage(seed: SeedCandidate, timeoutMs: number) {
  const homepage = normalizeLeadUrl(seed.homepageUrl)

  if (!homepage) {
    throw new Error(`Invalid homepage URL: ${seed.homepageUrl}`)
  }

  try {
    return await fetchText(homepage.toString(), timeoutMs)
  } catch {
    if (homepage.protocol === "https:") {
      const fallback = new URL(homepage.toString())
      fallback.protocol = "http:"
      return fetchText(fallback.toString(), timeoutMs)
    }

    throw new Error(`Could not fetch ${homepage.toString()}`)
  }
}

async function searchDuckDuckGo(query: string, limit: number, timeoutMs: number) {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetchText(searchUrl, timeoutMs)
  return extractDuckDuckGoResultUrls(response.text).slice(0, limit)
}

function parseCsvLine(line: string) {
  const values: string[] = []
  let current = ""
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]

    if (character === "\"") {
      const nextCharacter = line[index + 1]

      if (quoted && nextCharacter === "\"") {
        current += "\""
        index += 1
      } else {
        quoted = !quoted
      }

      continue
    }

    if (character === "," && !quoted) {
      values.push(current.trim())
      current = ""
      continue
    }

    current += character
  }

  values.push(current.trim())
  return values
}

async function loadSeedsFromFile(inputPath: string) {
  const absolutePath = resolve(inputPath)
  const contents = await readFile(absolutePath, "utf8")
  const extension = extname(absolutePath).toLowerCase()
  const seeds: string[] = []

  if (extension === ".csv") {
    const lines = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      return seeds
    }

    const headers = parseCsvLine(lines[0]!).map((value) => value.toLowerCase())
    const urlIndex = headers.findIndex((value) => ["domain", "url", "homepageurl"].includes(value.replaceAll(/\s+/g, "")))
    const fallbackIndex = urlIndex >= 0 ? urlIndex : 0

    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line)
      const value = values[fallbackIndex] ?? ""

      if (value) {
        seeds.push(value)
      }
    }

    return seeds
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    seeds.push(trimmed)
  }

  return seeds
}

async function mapWithConcurrency<T, TResult>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<TResult>,
) {
  const results: TResult[] = new Array(values.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(values[currentIndex]!, currentIndex)
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => worker())
  await Promise.all(workers)
  return results
}

function mergeSeedCandidates(urls: Array<{ url: string; query?: string }>) {
  const candidates = new Map<string, SeedCandidate>()

  for (const entry of urls) {
    const normalized = normalizeLeadUrl(entry.url)

    if (!normalized) {
      continue
    }

    const domain = normalizeDomain(normalized.hostname)

    if (DEFAULT_EXCLUDED_DOMAINS.includes(domain)) {
      continue
    }

    const existing = candidates.get(domain)

    if (existing) {
      existing.sourceQueries = joinUnique([...existing.sourceQueries, ...(entry.query ? [entry.query] : [])])
      continue
    }

    normalized.pathname = "/"
    normalized.search = ""
    normalized.hash = ""

    candidates.set(domain, {
      domain,
      homepageUrl: normalized.toString(),
      sourceQueries: entry.query ? [entry.query] : [],
    })
  }

  return Array.from(candidates.values())
}

async function auditLead(seed: SeedCandidate, timeoutMs: number): Promise<AuditedLead> {
  try {
    const homepage = await fetchHomepage(seed, timeoutMs)
    const candidateUrls = discoverCandidatePageUrls(homepage.finalUrl, homepage.text)
    const candidatePages = await mapWithConcurrency(candidateUrls.slice(0, 4), 2, async (url) => {
      try {
        const page = await fetchText(url, timeoutMs)
        return { url: page.finalUrl, html: page.text }
      } catch {
        return null
      }
    })
    const audit = scoreLeadAudit({
      domain: seed.domain,
      homepageUrl: homepage.finalUrl,
      homepageHtml: homepage.text,
      candidatePages: candidatePages.filter(Boolean) as Array<{ url: string; html: string }>,
    })

    return {
      domain: seed.domain,
      homepageUrl: homepage.finalUrl,
      sourceQueries: seed.sourceQueries,
      ...audit,
    }
  } catch (error) {
    return {
      domain: seed.domain,
      homepageUrl: seed.homepageUrl,
      companyName: seed.domain,
      shopifyDetected: false,
      wholesalePageUrl: null,
      wholesaleSignalCount: 0,
      contactEmail: null,
      vertical: null,
      erpDetected: false,
      score: 0,
      verdict: "Review",
      reasons: [`Fetch failed: ${error instanceof Error ? error.message : "Unknown error"}`],
      sourceQueries: seed.sourceQueries,
    }
  }
}

function toCsv(rows: AuditedLead[]) {
  const headers = [
    "domain",
    "companyName",
    "homepageUrl",
    "score",
    "verdict",
    "shopifyDetected",
    "wholesalePageUrl",
    "wholesaleSignalCount",
    "contactEmail",
    "vertical",
    "erpDetected",
    "sourceQueries",
    "reasons",
  ]

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.domain,
        row.companyName,
        row.homepageUrl,
        row.score,
        row.verdict,
        row.shopifyDetected,
        row.wholesalePageUrl,
        row.wholesaleSignalCount,
        row.contactEmail,
        row.vertical,
        row.erpDetected,
        row.sourceQueries.join(" | "),
        row.reasons.join(" | "),
      ]
        .map(csvEscape)
        .join(","),
    ),
  ]

  return `${lines.join("\n")}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!args.inputPath && args.queries.length === 0) {
    console.error(
      "Usage: npm run outbound:research -- --query 'shopify wholesale' [--query 'trade account shopify'] [--input seeds.txt] [--output tmp/outbound-targets.csv]",
    )
    process.exitCode = 1
    return
  }

  const seedUrls: Array<{ url: string; query?: string }> = []

  if (args.inputPath) {
    const seeds = await loadSeedsFromFile(args.inputPath)
    seedUrls.push(...seeds.map((url) => ({ url })))
  }

  for (const query of args.queries) {
    console.log(`Searching DuckDuckGo for: ${query}`)
    const urls = await searchDuckDuckGo(query, args.limitPerQuery, args.timeoutMs)
    seedUrls.push(...urls.map((url) => ({ url, query })))
  }

  const seeds = mergeSeedCandidates(seedUrls)

  if (seeds.length === 0) {
    console.error("No candidate domains found from the provided queries or seed file.")
    process.exitCode = 1
    return
  }

  console.log(`Auditing ${seeds.length} candidate domains...`)

  const audited = await mapWithConcurrency(seeds, args.concurrency, (seed) => auditLead(seed, args.timeoutMs))
  audited.sort((left, right) => right.score - left.score || left.domain.localeCompare(right.domain))

  const outputPath = resolve(args.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, toCsv(audited), "utf8")

  const summary = {
    total: audited.length,
    strongFit: audited.filter((lead) => lead.verdict === "Strong fit").length,
    review: audited.filter((lead) => lead.verdict === "Review").length,
    disqualify: audited.filter((lead) => lead.verdict === "Disqualify").length,
  }

  console.log(`Wrote ${audited.length} leads to ${outputPath}`)
  console.log(
    `Summary: ${summary.strongFit} strong fit, ${summary.review} review, ${summary.disqualify} disqualify`,
  )
}

await main()
