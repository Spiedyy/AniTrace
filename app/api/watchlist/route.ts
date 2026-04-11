import { NextRequest } from "next/server";
import { cookies } from "next/headers";

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("mal_access_token")?.value;

  if (!accessToken) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json();
  const { malId } = body;

  if (!malId) {
    return Response.json({ error: "malId is required" }, { status: 400 });
  }

  const res = await fetch(
    `https://api.myanimelist.net/v2/anime/${malId}/my_list_status`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ status: "plan_to_watch" }),
    }
  );

  if (!res.ok) {
    return Response.json(
      { error: "Failed to add to watchlist" },
      { status: res.status }
    );
  }

  return Response.json({ success: true });
}
