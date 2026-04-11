import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const codeVerifier = request.cookies.get("mal_code_verifier")?.value;

  if (!code || !codeVerifier) {
    return NextResponse.redirect(
      new URL("/?error=auth_failed", request.url)
    );
  }

  try {
    const tokenRes = await fetch("https://myanimelist.net/v1/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MAL_CLIENT_ID!,
        client_secret: process.env.MAL_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: process.env.MAL_REDIRECT_URI!,
      }),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(
        new URL("/?error=token_exchange_failed", request.url)
      );
    }

    const tokens = await tokenRes.json();

    const response = NextResponse.redirect(
      new URL("/?login=success", request.url)
    );

    response.cookies.set("mal_access_token", tokens.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: tokens.expires_in,
      path: "/",
    });

    response.cookies.set("mal_refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });

    response.cookies.delete("mal_code_verifier");

    return response;
  } catch {
    return NextResponse.redirect(
      new URL("/?error=auth_failed", request.url)
    );
  }
}
