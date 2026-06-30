import { promises as fs } from "fs";

export type TextExtractResult = {
  text: string;
  textPreview: string;
  extractedUrls: string[];
  error?: string;
};

const maxChars = 18000;

export async function extractPlainText(
  filePath: string
): Promise<TextExtractResult> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const text = raw.replace(/\u0000/g, "").slice(0, maxChars);
    return {
      text,
      textPreview: text.slice(0, 1200),
      extractedUrls: extractUrls(text)
    };
  } catch (error) {
    return {
      text: "",
      textPreview: "",
      extractedUrls: [],
      error: error instanceof Error ? error.message : "Text extraction failed"
    };
  }
}

export function extractUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s)\]'"<>]+/g) ?? [];
  return [...new Set(matches.map((url) => sanitizeUrl(url)).filter(Boolean))]
    .slice(0, 8) as string[];
}

function sanitizeUrl(url: string) {
  try {
    const parsed = new URL(url.replace(/[.,;:!?]+$/g, ""));
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}
