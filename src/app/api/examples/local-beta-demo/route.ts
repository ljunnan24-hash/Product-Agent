import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type DemoManifest = {
  id: string;
  title: string;
  brief: string;
  githubRepoUrl?: string;
  materials: Array<{
    name: string;
    path: string;
    mimeType: string;
    description?: string;
  }>;
};

export async function GET() {
  const demoRoot = path.join(process.cwd(), "examples", "local-beta-demo");
  const manifest = JSON.parse(
    await fs.readFile(path.join(demoRoot, "manifest.json"), "utf8")
  ) as DemoManifest;
  const materials = await Promise.all(
    manifest.materials.map(async (material) => ({
      ...material,
      content: await fs.readFile(path.join(demoRoot, material.path), "utf8")
    }))
  );

  return NextResponse.json({
    ...manifest,
    materials
  });
}
