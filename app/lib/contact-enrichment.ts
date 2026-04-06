import OpenAI from "openai";

export type EnrichedContact = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  position: string | null;
  confidence: number;
  source: "hunter" | "openai" | "fallback" | null;
};

// --- Hunter.io Integration ---

interface HunterEmail {
  value: string;
  type: string;
  confidence: number;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  department: string | null;
}

interface HunterDomainSearchResponse {
  data?: {
    domain: string;
    organization: string;
    emails?: HunterEmail[];
  };
  errors?: Array<{ details: string }>;
}

async function searchHunterIo(domain: string, apiKey: string): Promise<EnrichedContact | null> {
  try {
    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", domain);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("department", "executive,management,operations");
    url.searchParams.set("limit", "10");

    const response = await fetch(url.toString());
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as HunterDomainSearchResponse;
    const emails = payload.data?.emails || [];

    if (emails.length === 0) {
      return null;
    }

    // Rank emails by position and confidence
    const ranked = emails.sort((a, b) => {
      const aIsFounder = /founder|ceo|owner|director/i.test(a.position || "");
      const bIsFounder = /founder|ceo|owner|director/i.test(b.position || "");
      if (aIsFounder && !bIsFounder) return -1;
      if (!aIsFounder && bIsFounder) return 1;
      return b.confidence - a.confidence;
    });

    const best = ranked[0]!;
    return {
      firstName: best.first_name,
      lastName: best.last_name,
      email: best.value,
      position: best.position,
      confidence: best.confidence,
      source: "hunter",
    };
  } catch {
    return null;
  }
}

// --- OpenAI Fallback Scraping ---

async function fetchText(url: string, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeOpenAI(domain: string, openAiKey: string): Promise<EnrichedContact | null> {
  const aboutUrl = `https://${domain}/pages/about`;
  const contactUrl = `https://${domain}/pages/contact`;
  const homepageUrl = `https://${domain}`;

  const text = (await fetchText(aboutUrl)) || (await fetchText(homepageUrl)) || (await fetchText(contactUrl));
  if (!text) return null;

  try {
    const client = new OpenAI({ apiKey: openAiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an expert lead generator. From the following website text, identify the Founder, CEO, Owner, or primary contact. 
          Return ONLY JSON:
          {
            "firstName": "String or null",
            "lastName": "String or null",
            "position": "String or null",
            "email": "String or null, if found explicitly in text"
          }`
        },
        { role: "user", content: text.substring(0, 10000) }
      ]
    });

    const parsed = JSON.parse(completion.choices[0]?.message.content || "{}");
    
    // If we couldn't find a name, abort OpenAI fallback
    if (!parsed.firstName) return null;

    const email = parsed.email;

    return {
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      email: email || null,
      position: parsed.position,
      confidence: 50,
      source: "openai",
    };
  } catch {
    return null;
  }
}

// --- Main Enrichment Facade ---

export async function enrichContact(domain: string, fallbackEmail?: string | null): Promise<EnrichedContact> {
  const hunterKey = process.env.HUNTER_API_KEY?.trim();
  const openAiKey = process.env.OPENAI_API_KEY?.trim();

  let enriched: EnrichedContact | null = null;

  if (hunterKey) {
    enriched = await searchHunterIo(domain, hunterKey);
  }

  if (!enriched && openAiKey) {
    enriched = await scrapeOpenAI(domain, openAiKey);
  }

  if (enriched) {
    return enriched;
  }

  return {
    firstName: null,
    lastName: null,
    email: fallbackEmail || null,
    position: null,
    confidence: 0,
    source: fallbackEmail ? "fallback" : null,
  };
}
