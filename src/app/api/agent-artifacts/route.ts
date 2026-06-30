import { NextResponse } from "next/server";
import { readAgentArtifact } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const storageRef = url.searchParams.get("ref") || "";
  if (!storageRef) {
    return NextResponse.json({ error: "Missing artifact ref" }, { status: 400 });
  }

  const payload = await readAgentArtifact(storageRef);
  if (!payload) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  return NextResponse.json({
    storageRef,
    payload
  });
}
