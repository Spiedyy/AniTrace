import crypto from "crypto";
import { NextResponse } from "next/server";

// ── Cookie names ────────────────────────────────────────────────────────────
export const COOKIE_PKCE = "mal_pkce";          // { verifier, state } JSON blob
export const COOKIE_POPUP = "mal_is_popup";
export const COOKIE_ACCESS = "mal_access_token";
export const COOKIE_REFRESH = "mal_refresh_token";

// ── Cookie options ───────────────────────────────────────────────────────────
const SECURE = process.env.NODE_ENV === "production";

export function cookieOpts(maxAge: number) {
  return { httpOnly: true, secure: SECURE, sameSite: "lax" as const, path: "/", maxAge };
}

// ── PKCE (plain method — only method MAL supports) ───────────────────────────

/**
 * Generate PKCE verifier + state. When isPopup=true, the state is prefixed
 * with "p|" so the callback can identify the popup flow directly from the URL
 * parameter MAL echoes back — no separate cookie required.
 */
export function generatePkce(isPopup = false): { verifier: string; challenge: string; state: string } {
  // 64 random bytes → 86 base64url chars (within 43-128 char spec)
  const verifier = crypto.randomBytes(64).toString("base64url");
  const rand = crypto.randomBytes(16).toString("hex");
  const state = isPopup ? `p|${rand}` : rand;
  return { verifier, challenge: verifier, state }; // plain: challenge === verifier
}

/** Returns true when the state was generated for a popup flow. */
export function isPopupState(state: string): boolean {
  return state.startsWith("p|");
}

// ── Build the MAL authorization URL ─────────────────────────────────────────
export function buildAuthUrl(pkce: { challenge: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.MAL_CLIENT_ID!,
    code_challenge: pkce.challenge,
    code_challenge_method: "plain",
    redirect_uri: process.env.MAL_REDIRECT_URI!,
    state: pkce.state,
  });
  return `https://myanimelist.net/v1/oauth2/authorize?${params}`;
}

// ── Token types ──────────────────────────────────────────────────────────────
export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// ── Exchange authorization code for tokens ───────────────────────────────────
export async function exchangeCode(code: string, verifier: string): Promise<TokenSet | null> {
  const res = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MAL_CLIENT_ID!,
      client_secret: process.env.MAL_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: process.env.MAL_REDIRECT_URI!,
    }),
  });
  if (!res.ok) {
    console.error("[mal-auth] Token exchange failed:", res.status, await res.text().catch(() => ""));
    return null;
  }
  return res.json();
}

// ── Refresh an expired access token ─────────────────────────────────────────
export async function refreshTokens(refreshToken: string): Promise<TokenSet | null> {
  const res = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MAL_CLIENT_ID!,
      client_secret: process.env.MAL_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Cookie helpers ───────────────────────────────────────────────────────────
export function setTokenCookies(response: NextResponse, tokens: TokenSet) {
  response.cookies.set(COOKIE_ACCESS, tokens.access_token, cookieOpts(tokens.expires_in));
  response.cookies.set(COOKIE_REFRESH, tokens.refresh_token, cookieOpts(60 * 60 * 24 * 31));
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.delete(COOKIE_ACCESS);
  response.cookies.delete(COOKIE_REFRESH);
  response.cookies.delete(COOKIE_PKCE);
  response.cookies.delete(COOKIE_POPUP);
}

// ── Popup close page ─────────────────────────────────────────────────────────
export function popupClosePage(success: boolean): NextResponse {
  const script = success
    ? `window.opener?.postMessage({type:"mal_auth",success:true},window.location.origin);window.close();`
    : `window.opener?.postMessage({type:"mal_auth",success:false},window.location.origin);window.close();`;
  const body = success ? "Connected! Closing…" : "Authentication failed. Closing…";
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${body}</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#8b949e"><p>${body}</p><script>${script}</script></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}
