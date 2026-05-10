import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE_ACCESS, COOKIE_REFRESH, refreshTokens, setTokenCookies } from "@/lib/mal-auth";

export async function GET() {
  const store = await cookies();
  const accessToken = store.get(COOKIE_ACCESS)?.value;
  const refreshToken = store.get(COOKIE_REFRESH)?.value;

  if (accessToken) {
    // Verify the token is still accepted by MAL
    const check = await fetch("https://api.myanimelist.net/v2/users/@me?fields=name,picture", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });

    if (check.ok) {
      const user = await check.json();
      return NextResponse.json({ loggedIn: true, name: user.name, picture: user.picture });
    }

    // Access token rejected — try refresh
    if (refreshToken) {
      const newTokens = await refreshTokens(refreshToken);
      if (newTokens) {
        const response = NextResponse.json({ loggedIn: true });
        setTokenCookies(response, newTokens);
        return response;
      }
    }

    // Both expired — clear cookies and report logged out
    const response = NextResponse.json({ loggedIn: false });
    response.cookies.delete(COOKIE_ACCESS);
    response.cookies.delete(COOKIE_REFRESH);
    return response;
  }

  return NextResponse.json({ loggedIn: false });
}
