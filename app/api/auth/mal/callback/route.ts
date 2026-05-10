import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_PKCE, COOKIE_POPUP,
  exchangeCode, setTokenCookies, clearAuthCookies, popupClosePage,
} from "@/lib/mal-auth";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  const oauthError = searchParams.get("error");

  const pkceRaw = request.cookies.get(COOKIE_PKCE)?.value;
  const isPopup = request.cookies.get(COOKIE_POPUP)?.value === "1";

  function fail(reason: string): NextResponse {
    console.error("[mal/callback] Auth failed:", reason);
    if (isPopup) return popupClosePage(false);
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(reason)}`, origin));
  }

  // User denied access on MAL's page
  if (oauthError) return fail(oauthError);

  // Missing required values
  if (!code || !pkceRaw) return fail("missing_params");

  // Parse the stored PKCE blob
  let pkce: { verifier: string; state: string };
  try {
    pkce = JSON.parse(pkceRaw);
  } catch {
    return fail("invalid_session");
  }

  // Validate state — prevents CSRF
  if (!returnedState || returnedState !== pkce.state) return fail("state_mismatch");

  // Exchange authorization code for access + refresh tokens
  const tokens = await exchangeCode(code, pkce.verifier);
  if (!tokens) return fail("token_exchange_failed");

  if (isPopup) {
    const response = popupClosePage(true);
    setTokenCookies(response, tokens);
    response.cookies.delete(COOKIE_PKCE);
    response.cookies.delete(COOKIE_POPUP);
    return response;
  }

  const response = NextResponse.redirect(new URL("/?login=success", origin));
  setTokenCookies(response, tokens);
  response.cookies.delete(COOKIE_PKCE);
  return response;
}
