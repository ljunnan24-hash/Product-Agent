import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

export async function GET() {
  try {
    const result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "local-doctor.mjs"), "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 256_000
      }
    );
    return NextResponse.json(parseDoctorOutput(result.stdout));
  } catch (error) {
    const output = error && typeof error === "object" && "stdout" in error
      ? String(error.stdout || "")
      : "";
    if (output.trim()) {
      return NextResponse.json(parseDoctorOutput(output));
    }
    return NextResponse.json(
      {
        summary: {
          status: "block",
          total: 1,
          passed: 0,
          warnings: 0,
          blockers: 1
        },
        checks: [
          {
            id: "local-health",
            label: "Local health",
            status: "block",
            summary: error instanceof Error ? error.message : "doctor check failed",
            details: ["Run pnpm doctor in the project root for the full diagnostic output."]
          }
        ]
      },
      { status: 200 }
    );
  }
}

function parseDoctorOutput(output: string) {
  try {
    return JSON.parse(output);
  } catch {
    return {
      summary: {
        status: "block",
        total: 1,
        passed: 0,
        warnings: 0,
        blockers: 1
      },
      checks: [
        {
          id: "local-health",
          label: "Local health",
          status: "block",
          summary: "doctor returned invalid JSON",
          details: [output.slice(0, 500)]
        }
      ]
    };
  }
}
