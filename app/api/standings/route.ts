import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

// Compétitions disponibles gratuitement chez Football-Data.org.
// La Ligue 2 n'en fait pas partie.
const COMPETITION_CODES: Record<string, string> = {
  "ligue-1": "FL1",
  "champions-league": "CL",
  "premier-league": "PL",
  "la-liga": "PD",
  "serie-a": "SA",
  "bundesliga": "BL1",
};

// GET /api/standings?competition=ligue-1
export async function GET(request: NextRequest) {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json(
        { standings: [], error: "FOOTBALL_DATA_API_KEY manquante" },
        { status: 500 }
      );
    }

    const slug = request.nextUrl.searchParams.get("competition") || "ligue-1";
    const code = COMPETITION_CODES[slug];

    if (!code) {
      return NextResponse.json(
        {
          standings: [],
          error: "Classement non disponible pour cette compétition.",
        },
        { status: 404 }
      );
    }

    const response = await fetch(
      `https://api.football-data.org/v4/competitions/${code}/standings`,
      {
        headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY },
        next: { revalidate: 300 }, // classement rafraîchi toutes les 5 minutes
      }
    );

    if (!response.ok) {
      console.error("Standings API error:", response.status, await response.text());
      return NextResponse.json(
        { standings: [], error: "Classement indisponible" },
        { status: response.status }
      );
    }

    const data = await response.json();

    const groups = Array.isArray(data?.standings) ? data.standings : [];
    const total =
      groups.find((group: any) => group?.type === "TOTAL") || groups[0];
    const table = Array.isArray(total?.table) ? total.table : [];

    const standings = table.map((row: any) => ({
      position: row?.position,
      team: row?.team?.shortName || row?.team?.name || "Équipe inconnue",
      played: row?.playedGames ?? 0,
      won: row?.won ?? 0,
      drawn: row?.draw ?? 0,
      lost: row?.lost ?? 0,
      goalsFor: row?.goalsFor ?? 0,
      goalsAgainst: row?.goalsAgainst ?? 0,
      points: row?.points ?? 0,
      logo: row?.team?.crest ?? undefined,
    }));

    return NextResponse.json({ standings });
  } catch (error) {
    console.error("Standings error:", error);
    return NextResponse.json(
      { standings: [], error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
