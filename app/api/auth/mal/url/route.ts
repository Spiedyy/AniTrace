import { NextRequest, NextResponse } from "next/server";
import { generatePkce, buildAuthUrl, COOKIE_PKCE, COOKIE_POPUP, cookieOpts } from "@/lib/mal-auth";

/**
 * GET /api/auth/mal/url?popup=1
 *
 * Returns the MAL OAuth authorization URL as JSON and sets the PKCE + state
 * cookie. The client opens a popup directly to that URL so no redirect through
 * localhost is needed (Chrome blocks cross-origin popup redirects).
 */
export async function GET(request: NextRequest) {
  if (!process.env.MAL_CLIENT_ID || !process.env.MAL_REDIRECT_URI) {
    return NextResponse.json({ error: "MAL OAuth is not configured" }, { status: 503 });
  }

  const pkce = generatePkce();
  const isPopup = request.nextUrl.searchParams.get("popup") === "1";

  const response = NextResponse.json({ url: buildAuthUrl(pkce) });

  // Store verifier + state together so the callback can validate both
  response.cookies.set(
    COOKIE_PKCE,
    JSON.stringify({ verifier: pkce.verifier, state: pkce.state }),
    cookieOpts(600)
  );

  if (isPopup) {
    response.cookies.set(COOKIE_POPUP, "1", cookieOpts(600));
  }

  return response;
}
