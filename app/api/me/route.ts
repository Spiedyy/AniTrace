import { cookies } from "next/headers";

export async function GET() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("mal_access_token")?.value;
  return Response.json({ loggedIn: !!accessToken });
}
