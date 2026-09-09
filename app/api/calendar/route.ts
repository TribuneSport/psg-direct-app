import { NextResponse } from "next/server";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PSG_ID = "524";

export async function GET() {
  try {
    if (!API_KEY) {
      return NextResponse.json(
        {
          error: "FOOTBALL_DATA_API_KEY manquante",
          matches: [],
        },
        { status: 500 }
      );
    }

    const today = new Date();

    const dateFrom = new Date(today);
    dateFrom.setDate(dateFrom.getDate() - 30);

    const dateTo = new Date(today);
    dateTo.setDate(dateTo.getDate() + 365);

    const formatDate = (date: Date) => {
      return date.toISOString().slice(0, 10);
    };

    const url =
      `https://api.football-data.org/v4/teams/${PSG_ID}/matches` +
      `?dateFrom=${formatDate(dateFrom)}` +
      `&dateTo=${formatDate(dateTo)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();

      return NextResponse.json(
        {
          error: "Erreur Football-Data",
          status: response.status,
          details: errorText,
          matches: [],
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    const matches = Array.isArray(data.matches)
      ? data.matches
          .map((match: any) => {
            const homeTeam = match.homeTeam ?? {};
            const awayTeam = match.awayTeam ?? {};

            const isPsgHome =
              Number(homeTeam.id) === Number(PSG_ID);

            const opponent = isPsgHome
              ? awayTeam
              : homeTeam;

            return {
              id: match.id,

              date: match.utcDate,

              status: match.status,

              competition: {
                id: match.competition?.id ?? null,
                name:
                  match.competition?.name ??
                  "Compétition",
                code:
                  match.competition?.code ?? null,
                emblem:
                  match.competition?.emblem ?? null,
              },

              homeTeam: {
                id: homeTeam.id ?? null,
                name:
                  homeTeam.name ??
                  "Paris Saint-Germain",
                shortName:
                  homeTeam.shortName ??
                  homeTeam.name ??
                  "Paris Saint-Germain",
                tla: homeTeam.tla ?? null,
                crest:
                  homeTeam.crest ?? null,
              },

              awayTeam: {
                id: awayTeam.id ?? null,
                name:
                  awayTeam.name ??
                  "Adversaire",
                shortName:
                  awayTeam.shortName ??
                  awayTeam.name ??
                  "Adversaire",
                tla: awayTeam.tla ?? null,
                crest:
                  awayTeam.crest ?? null,
              },

              opponent: {
                id: opponent.id ?? null,
                name:
                  opponent.name ??
                  "Adversaire",
                shortName:
                  opponent.shortName ??
                  opponent.name ??
                  "Adversaire",
                tla: opponent.tla ?? null,
                crest:
                  opponent.crest ?? null,
              },

              isPsgHome,

              score: {
                home:
                  typeof match.score?.fullTime?.home ===
                  "number"
                    ? match.score.fullTime.home
                    : null,

                away:
                  typeof match.score?.fullTime?.away ===
                  "number"
                    ? match.score.fullTime.away
                    : null,
              },

              venue: match.venue ?? null,

              matchday:
                match.matchday ?? null,

              stage:
                match.stage ?? null,
            };
          })
          .sort(
            (a: any, b: any) =>
              new Date(a.date).getTime() -
              new Date(b.date).getTime()
          )
      : [];

    return NextResponse.json(
      {
        team: {
          id: PSG_ID,
          name: "Paris Saint-Germain",
        },

        count: matches.length,

        matches,

        lastUpdated:
          new Date().toISOString(),
      },
      {
        status: 200,

        headers: {
          "Cache-Control":
            "no-store, no-cache, must-revalidate, proxy-revalidate",

          Pragma: "no-cache",

          Expires: "0",
        },
      }
    );
  } catch (error) {
    console.error(
      "Erreur /api/calendar:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Erreur interne du calendrier",
        matches: [],
      },
      { status: 500 }
    );
  }
}
