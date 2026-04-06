import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import "dotenv/config";

import { enrichContact, type EnrichedContact } from "../app/lib/contact-enrichment";

type Args = {
  inputPath: string;
  outputPath: string;
  concurrency: number;
};

type CsvRow = {
  domain: string;
  companyName: string;
  contactEmail: string;
  score: string;
  verdict: string;
  wholesalePageUrl: string;
  [key: string]: string;
};

type EnrichedCsvRow = {
  row: CsvRow;
  enriched: EnrichedContact;
};

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    inputPath: "tmp/outbound-targets.csv",
    outputPath: "tmp/outreach-queue.csv",
    concurrency: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if ((value === "--input" || value === "-i") && argv[index + 1]) {
      parsed.inputPath = argv[index + 1]!;
      index += 1;
      continue;
    }

    if ((value === "--output" || value === "-o") && argv[index + 1]) {
      parsed.outputPath = argv[index + 1]!;
      index += 1;
      continue;
    }

    if ((value === "--concurrency" || value === "-c") && argv[index + 1]) {
      parsed.concurrency = Number(argv[index + 1] ?? parsed.concurrency) || parsed.concurrency;
      index += 1;
      continue;
    }
  }

  return parsed;
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "\"") {
      const nextCharacter = line[index + 1];

      if (quoted && nextCharacter === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (character === "," && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current.trim());
  return values;
}

async function loadTargets(inputPath: string): Promise<CsvRow[]> {
  const absolutePath = resolve(inputPath);
  try {
    const contents = await readFile(absolutePath, "utf8");
    const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    if (lines.length < 2) {
      return [];
    }

    const headers = parseCsvLine(lines[0]!).map((h) => h.trim());
    const rows: CsvRow[] = [];

    for (const line of lines.slice(1)) {
      const values = parseCsvLine(line);
      const row = {} as CsvRow;
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]!] = values[i] ?? "";
      }
      rows.push(row);
    }

    return rows;
  } catch (error) {
    console.error(`Failed to load ${inputPath}: ${error}`);
    return [];
  }
}

function csvEscape(value: string | number | boolean | null | undefined) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  const escaped = stringValue.replaceAll("\"", "\"\"");
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function toCsv(rows: EnrichedCsvRow[]) {
  const headers = [
    "domain",
    "companyName",
    "firstName",
    "lastName",
    "email",
    "position",
    "confidence",
    "source",
    "score",
    "verdict",
    "wholesalePageUrl"
  ];

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.row.domain ?? "",
        row.row.companyName ?? "",
        row.enriched.firstName ?? "",
        row.enriched.lastName ?? "",
        row.enriched.email ?? "",
        row.enriched.position ?? "",
        row.enriched.confidence,
        row.enriched.source ?? "",
        row.row.score ?? "0",
        row.row.verdict ?? "",
        row.row.wholesalePageUrl ?? "",
      ]
        .map(csvEscape)
        .join(","),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

async function mapWithConcurrency<T, TResult>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<TResult>,
) {
  const results: TResult[] = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]!, currentIndex);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Loading targets from ${args.inputPath}...`);
  const allRows = await loadTargets(args.inputPath);

  if (allRows.length === 0) {
    console.error("No valid targets found in input file.");
    process.exitCode = 1;
    return;
  }

  // Only enrich 'Strong fit' and 'Review'
  const filterTargets = allRows.filter((r) => r.verdict === "Strong fit" || r.verdict === "Review");

  console.log(`Found ${filterTargets.length} qualified leads to enrich out of ${allRows.length} total.`);

  if (!process.env.HUNTER_API_KEY) {
    console.warn("⚠️ HUNTER_API_KEY missing - skipping Hunter.io API.");
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️ OPENAI_API_KEY missing - skipping OpenAI webpage fallback.");
  }

  let enrichedCount = 0;

  const enrichedRows = await mapWithConcurrency<CsvRow, EnrichedCsvRow>(filterTargets, args.concurrency, async (row) => {
    const domain = row.domain;
    const fallbackEmail = row.contactEmail;
    console.log(`Enriching ${domain}...`);
    
    const enriched = await enrichContact(domain, fallbackEmail);
    if (enriched.email && enriched.source !== "fallback") {
      enrichedCount++;
    }

    return { row, enriched };
  });

  const outputPath = resolve(args.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, toCsv(enrichedRows), "utf8");

  console.log(`\n✅ Finished enrichment.`);
  console.log(`Wrote ${enrichedRows.length} leads to ${outputPath}`);
  console.log(`Found actionable contact emails for ${enrichedCount} leads.`);
}

await main();
