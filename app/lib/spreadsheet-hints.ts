export const SPREADSHEET_HINT_CONFIG = [
  { key: "poNumber", label: "PO number columns" },
  { key: "customerName", label: "Customer columns" },
  { key: "companyName", label: "Company columns" },
  { key: "contactEmail", label: "Contact email columns" },
  { key: "merchantSku", label: "Merchant SKU columns" },
  { key: "customerSku", label: "Customer SKU columns" },
  { key: "description", label: "Description columns" },
  { key: "quantity", label: "Quantity columns" },
  { key: "unitPrice", label: "Unit price columns" },
  { key: "uom", label: "Unit of measure columns" },
] as const;

export type SpreadsheetHintKey = (typeof SPREADSHEET_HINT_CONFIG)[number]["key"];
export type SpreadsheetHints = Partial<Record<SpreadsheetHintKey, string[]>>;

export function parseSpreadsheetHints(value: unknown): SpreadsheetHints {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const parsedHints: SpreadsheetHints = {};

  for (const hintConfig of SPREADSHEET_HINT_CONFIG) {
    const rawValue = (value as Record<string, unknown>)[hintConfig.key];
    const values = Array.isArray(rawValue)
      ? rawValue
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean)
      : typeof rawValue === "string"
        ? rawValue
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];

    if (values.length > 0) {
      parsedHints[hintConfig.key] = Array.from(new Set(values));
    }
  }

  return parsedHints;
}
