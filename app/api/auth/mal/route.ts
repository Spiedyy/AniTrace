import { NextResponse } from "next/server";
import { generatePkce, buildAuthUrl, COOKIE_PKCE, cookieOpts } from "@/lib/mal-auth";

/**
 * GET /api/auth/mal
 *
 * Full-page redirect fallback — used when the popup is blocked by the browser.
 * Sets PKCE cookie and redirects directly to MAL's authorization page.
 */
export async function GET() {
  if (!process.env.MAL_CLIENT_ID || !process.env.MAL_REDIRECT_URI) {
    return NextResponse.json({ error: "MAL OAuth is not configured" }, { status: 503 });
  }

  const pkce = generatePkce();
  const response = NextResponse.redirect(buildAuthUrl(pkce));

  response.cookies.set(
    COOKIE_PKCE,
    JSON.stringify({ verifier: pkce.verifier, state: pkce.state }),
    cookieOpts(600)
  );

  return response;
}
