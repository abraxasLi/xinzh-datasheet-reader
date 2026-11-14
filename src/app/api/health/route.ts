import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    mode: "local-index",
    aiEnabled: false,
    documentPersistence: "process-memory",
  });
}
