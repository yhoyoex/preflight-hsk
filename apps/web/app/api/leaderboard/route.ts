import { leaderboard } from "@/lib/leaderboard";

// Static snapshot written by `pnpm snapshot` (apps/web/data/leaderboard.json).
export const dynamic = "force-static";

export function GET() {
  return Response.json(leaderboard, { headers: { "cache-control": "public, max-age=300, s-maxage=3600" } });
}
