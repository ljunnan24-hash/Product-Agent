import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const bundledPython =
  "/Users/junnan/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

export type PdfExtractResult = {
  text: string;
  textPreview: string;
  pageCount: number;
  error?: string;
};

export async function extractPdfText(filePath: string): Promise<PdfExtractResult> {
  const python = process.env.PDF_PYTHON_PATH || bundledPython;
  const script = String.raw`
import json
import sys

path = sys.argv[1]
max_pages = int(sys.argv[2])
max_chars = int(sys.argv[3])

try:
    import pdfplumber
    parts = []
    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages[:max_pages]:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text.strip())
    text = "\n\n".join(parts)
    text = text[:max_chars]
    print(json.dumps({
        "text": text,
        "textPreview": text[:1200],
        "pageCount": page_count
    }, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({
        "text": "",
        "textPreview": "",
        "pageCount": 0,
        "error": str(exc)
    }, ensure_ascii=False))
`;

  try {
    const { stdout } = await execFileAsync(
      python,
      ["-c", script, filePath, "8", "12000"],
      {
        timeout: 20000,
        maxBuffer: 1024 * 1024 * 2
      }
    );
    return JSON.parse(stdout.trim()) as PdfExtractResult;
  } catch (error) {
    return {
      text: "",
      textPreview: "",
      pageCount: 0,
      error: error instanceof Error ? error.message : "PDF extraction failed"
    };
  }
}
