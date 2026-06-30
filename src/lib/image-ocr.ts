import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export type ImageOcrResult = {
  text: string;
  textPreview: string;
  engine: "apple_vision";
  averageConfidence: number;
  observations: Array<{
    text: string;
    confidence: number;
  }>;
  error?: string;
};

export async function extractImageText(filePath: string): Promise<ImageOcrResult> {
  const swiftPath = process.env.SWIFT_PATH || "/usr/bin/swift";
  const scriptPath = path.join(process.cwd(), "scripts", "vision-ocr.swift");

  try {
    const { stdout } = await execFileAsync(swiftPath, [scriptPath, filePath], {
      timeout: 25000,
      maxBuffer: 1024 * 1024 * 2
    });
    const parsed = JSON.parse(stdout.trim()) as ImageOcrResult;
    return {
      text: parsed.text || "",
      textPreview: parsed.textPreview || "",
      engine: "apple_vision",
      averageConfidence: Number(parsed.averageConfidence || 0),
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      error: parsed.error || undefined
    };
  } catch (error) {
    return {
      text: "",
      textPreview: "",
      engine: "apple_vision",
      averageConfidence: 0,
      observations: [],
      error: error instanceof Error ? error.message : "Image OCR failed"
    };
  }
}
