import { NextResponse } from "next/server";
import crypto from "crypto";

export async function GET() {
  if (!process.env.MAL_CLIENT_ID || !process.env.MAL_REDIRECT_URI) {
    return NextResponse.json(
      { error: "MAL OAuth is not configured on this server" },
      { status: 503 }
    );
  }

  // Generate PKCE code verifier (43-128 chars, URL-safe)
  const codeVerifier = crypto
    .randomBytes(64)
    .toString("base64url")
    .slice(0, 128);

  // MAL uses "plain" PKCE — code_challenge === code_verifier
  const codeChallenge = codeVerifier;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.MAL_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "plain",
    redirect_uri: process.env.MAL_REDIRECT_URI,
    state: crypto.randomBytes(16).toString("hex"),
  });

  const response = NextResponse.redirect(
    `https://myanimelist.net/v1/oauth2/authorize?${params}`
  );

  response.cookies.set("mal_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
