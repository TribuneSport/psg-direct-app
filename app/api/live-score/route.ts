import { NextResponse } from "next/server";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY!;
const PSG_TEAM_ID = "524";

export async function GET() {
  try {
    const today = new Date();
    const dateFrom = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
    const dateTo = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

    const res = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { "X-Auth-Token": API_KEY }, next: { revalidate: 30 } }
    );

    if (!res.ok) return NextResponse.json({ liveScore: null, error: "API indisponible" });

    const data = await res.json();
    const match = data.matches?.[0];
    if (!match) return NextResponse.json({ liveScore: null });

    const isHome = match.homeTeam.id.toString() === PSG_TEAM_ID;
    return NextResponse.json({
      liveScore: {
        competition: match.competition.name,
        status: mapStatus(match.status),
        minute: match.minute ?? null,
        homeTeam: match.homeTeam.shortName ?? match.homeTeam.name,
        awayTeam: match.awayTeam.shortName ?? match.awayTeam.name,
        homeScore: match.score.fullTime.home ?? match.score.halfTime.home ?? 0,
        awayScore: match.score.fullTime.away ?? match.score.halfTime.away ?? 0,
        isLive: match.status === "IN_PLAY" || match.status === "PAUSED",
        isPsgHome: isHome,
      },
    });
  } catch (e) {
    return NextResponse.json({ liveScore: null, error: "Erreur réseau" });
  }
}

function mapStatus(status: string) {
  const map: Record<string, string> = {
    SCHEDULED: "À venir", TIMED: "À venir", IN_PLAY: "En direct",
    PAUSED: "Mi-temps", FINISHED: "Terminé", POSTPONED: "Reporté", CANCELLED: "Annulé",
  };
  return map[status] ?? status;
}
