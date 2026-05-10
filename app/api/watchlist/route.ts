import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_ACCESS, COOKIE_REFRESH, refreshTokens, setTokenCookies } from "@/lib/mal-auth";

interface MalAnimeListStatusResponse {
  my_list_status?: {
    status?: string;
  };
}

async function putWatchlist(malId: number, accessToken: string): Promise<Response> {
  return fetch(`https://api.myanimelist.net/v2/anime/${malId}/my_list_status`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ status: "plan_to_watch" }),
  });
}

async function getExistingListStatus(malId: number, accessToken: string): Promise<string | null> {
  const response = await fetch(`https://api.myanimelist.net/v2/anime/${malId}?fields=my_list_status`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch existing list status: ${response.status}`);
  }

  const data = (await response.json()) as MalAnimeListStatusResponse;
  return data.my_list_status?.status ?? null;
}

export async function POST(request: NextRequest) {
  const store = await cookies();
  const accessToken = store.get(COOKIE_ACCESS)?.value;
  const refreshToken = store.get(COOKIE_REFRESH)?.value;

  if (!accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json();
  const { malId } = body;
  if (!malId || typeof malId !== "number") {
    return NextResponse.json({ error: "malId is required" }, { status: 400 });
  }

  let currentStatus: string | null = null;
  try {
    currentStatus = await getExistingListStatus(malId, accessToken);
  } catch {
    // If status lookup fails, continue with the existing PUT flow.
  }

  if (currentStatus === "completed") {
    return NextResponse.json({ success: true, skipped: true, reason: "already_completed" });
  }

  let res = await putWatchlist(malId, accessToken);

  // Auto-refresh on 401 and retry once
  if (res.status === 401 && refreshToken) {
    const newTokens = await refreshTokens(refreshToken);
    if (newTokens) {
      // Re-check with fresh token to avoid overwriting a completed entry.
      try {
        currentStatus = await getExistingListStatus(malId, newTokens.access_token);
      } catch {
        currentStatus = null;
      }
      if (currentStatus === "completed") {
        const response = NextResponse.json({ success: true, skipped: true, reason: "already_completed" });
        setTokenCookies(response, newTokens);
        return response;
      }

      res = await putWatchlist(malId, newTokens.access_token);
      if (res.ok) {
        const response = NextResponse.json({ success: true });
        setTokenCookies(response, newTokens);
        return response;
      }
    }
    return NextResponse.json({ error: "Session expired — please log in again" }, { status: 401 });
  }

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to add to watchlist" }, { status: res.status });
  }

  return NextResponse.json({ success: true });
}
