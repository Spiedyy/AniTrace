import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete("mal_access_token");
  response.cookies.delete("mal_refresh_token");
  return response;
}
