import { NextResponse } from "next/server";

const FOOTBALL_DATA_API_KEY =
  process.env.FOOTBALL_DATA_API_KEY;

const PSG_ID = "524";

function getDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getTeamName(team: any) {
  return (
    team?.name ||
    team?.shortName ||
    team?.tla ||
    "Équipe inconnue"
  );
}

function getTeamLogo(team: any) {
  return team?.crest || null;
}

function getScore(match: any) {
  const fullTime = match?.score?.fullTime;

  return {
    home:
      typeof fullTime?.home === "number"
        ? fullTime.home
        : 0,
    away:
      typeof fullTime?.away === "number"
        ? fullTime.away
        : 0,
  };
}

export async function GET() {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json(
        {
          error:
            "FOOTBALL_DATA_API_KEY manquante",
        },
        { status: 500 }
      );
    }

    const today = new Date();

    const from = new Date(today);
    from.setDate(from.getDate() - 7);

    const to = new Date(today);
    to.setDate(to.getDate() + 7);

    const url =
      `https://api.football-data.org/v4/teams/${PSG_ID}/matches` +
      `?dateFrom=${getDateString(from)}` +
      `&dateTo=${getDateString(to)}` +
      `&limit=20`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Auth-Token": FOOTBALL_DATA_API_KEY,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();

      console.error(
        "Football-Data API error:",
        response.status,
        text
      );

      return NextResponse.json(
        {
          error:
            "Impossible de récupérer les données du match",
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    const matches = Array.isArray(data?.matches)
      ? data.matches
      : [];

    if (matches.length === 0) {
      return NextResponse.json({
        liveScore: null,
      });
    }

    const liveMatches = matches.filter(
      (match: any) =>
        match?.status === "IN_PLAY" ||
        match?.status === "PAUSED"
    );

    const finishedMatches = matches
      .filter(
        (match: any) =>
          match?.status === "FINISHED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(b.utcDate).getTime() -
          new Date(a.utcDate).getTime()
      );

    const upcomingMatches = matches
      .filter(
        (match: any) =>
          match?.status === "SCHEDULED" ||
          match?.status === "TIMED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() -
          new Date(b.utcDate).getTime()
      );

    const match =
      liveMatches[0] ||
      finishedMatches[0] ||
      upcomingMatches[0];

    if (!match) {
      return NextResponse.json({
        liveScore: null,
      });
    }

    const score = getScore(match);

    const isPsgHome =
      String(match?.homeTeam?.id) === PSG_ID;

    const homeTeam = {
      name: getTeamName(match?.homeTeam),
      logo: getTeamLogo(match?.homeTeam),
      id: match?.homeTeam?.id ?? null,
    };

    const awayTeam = {
      name: getTeamName(match?.awayTeam),
      logo: getTeamLogo(match?.awayTeam),
      id: match?.awayTeam?.id ?? null,
    };

    let minute: string | null = null;

    if (
      match?.status === "IN_PLAY" ||
      match?.status === "PAUSED"
    ) {
      const matchMinute = match?.minute;

      if (
        matchMinute &&
        typeof matchMinute === "object"
      ) {
        if (
          typeof matchMinute.inPlay === "number"
        ) {
          minute = `${matchMinute.inPlay}'`;
        } else if (
          typeof matchMinute.extraTime === "number"
        ) {
          minute = `${matchMinute.extraTime}'`;
        }
      } else if (
        typeof matchMinute === "number"
      ) {
        minute = `${matchMinute}'`;
      } else if (
        typeof matchMinute === "string"
      ) {
        minute = matchMinute;
      }
    }

    let matchStatus = "UPCOMING";

    if (
      match.status === "IN_PLAY" ||
      match.status === "PAUSED"
    ) {
      matchStatus = "LIVE";
    } else if (
      match.status === "FINISHED"
    ) {
      matchStatus = "FINISHED";
    }

    const liveScore = {
      competition:
        match?.competition?.name ||
        "Football",

      status:
        match?.status === "FINISHED"
          ? "Terminé"
          : match?.status === "IN_PLAY"
            ? "En direct"
            : match?.status === "PAUSED"
              ? "Mi-temps"
              : "À venir",

      minute,

      homeTeam: homeTeam.name,
      awayTeam: awayTeam.name,

      homeLogo: homeTeam.logo,
      awayLogo: awayTeam.logo,

      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,

      homeScore: score.home,
      awayScore: score.away,

      isLive:
        match?.status === "IN_PLAY" ||
        match?.status === "PAUSED",

      isPsgHome,

      goals: Array.isArray(match?.goals)
        ? match.goals
        : [],

      cards: Array.isArray(match?.bookings)
        ? match.bookings
        : [],

      substitutions: Array.isArray(
        match?.substitutions
      )
        ? match.substitutions
        : [],

      events: [],

      kickoff: match?.utcDate || null,

      matchStatus,

      venue: match?.venue || null,

      matchday: match?.matchday || null,

      stage: match?.stage || null,

      lastUpdated:
        new Date().toISOString(),
    };

    return NextResponse.json(
      {
        liveScore,
      },
      {
        headers: {
          "Cache-Control":
            "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error) {
    console.error(
      "Live score error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Erreur serveur lors de la récupération du score",
      },
      { status: 500 }
    );
  }
}
