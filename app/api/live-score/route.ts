import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

const PSG_ID = "524";
const API_URL = "https://api.football-data.org/v4";

function getDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getTeamName(team: any) {
  return team?.name || team?.shortName || team?.tla || "Équipe inconnue";
}

function getTeamLogo(team: any) {
  return team?.crest || null;
}

function getScore(match: any) {
  const fullTime = match?.score?.fullTime;

  return {
    home: typeof fullTime?.home === "number" ? fullTime.home : 0,
    away: typeof fullTime?.away === "number" ? fullTime.away : 0,
  };
}

// Appel à Football-Data.org, avec un cache de 20 secondes côté serveur
// pour rester sous la limite de 10 requêtes par minute, même avec
// plusieurs téléphones qui rafraîchissent en même temps.
async function footballData(path: string) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
    next: { revalidate: 20 },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Football-Data API error:", response.status, text);

    const error: any = new Error(`Football-Data ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Transforme une minute de l'API (nombre, objet ou texte) en "67'" ou "45+2'".
function formatMinute(value: any, injuryTime?: number | null): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "object") {
    if (typeof value.inPlay === "number") {
      return `${value.inPlay}'`;
    }
    if (typeof value.extraTime === "number") {
      return `${value.extraTime}'`;
    }
    return null;
  }

  if (typeof value === "number") {
    return injuryTime ? `${value}+${injuryTime}'` : `${value}'`;
  }

  const text = String(value);
  return text.includes("'") ? text : `${text}'`;
}

// Quand l'API ne donne pas la minute (cas fréquent avec l'offre gratuite),
// on l'estime à partir de l'heure du coup d'envoi.
function estimateMinute(match: any): string | null {
  if (match?.status === "PAUSED") {
    return "MT";
  }

  if (match?.status !== "IN_PLAY" || !match?.utcDate) {
    return null;
  }

  const elapsed = Math.floor(
    (Date.now() - new Date(match.utcDate).getTime()) / 60000
  );

  if (elapsed < 0) {
    return null;
  }

  // Environ 15 minutes de pause à la mi-temps.
  const minute = elapsed <= 45 ? Math.max(elapsed, 1) : Math.max(46, elapsed - 15);

  return minute > 90 ? "90+'" : `${minute}'`;
}

function buildGoals(match: any) {
  const goals = Array.isArray(match?.goals) ? match.goals : [];

  return goals.map((goal: any) => {
    let playerName = goal?.scorer?.name || "But";

    if (goal?.type === "OWN") {
      playerName += " (c.s.c.)";
    } else if (goal?.type === "PENALTY") {
      playerName += " (pen.)";
    }

    return {
      minute: formatMinute(goal?.minute, goal?.injuryTime),
      playerName,
      scorer: goal?.scorer ?? null,
      assist: goal?.assist?.name ?? null,
      type: goal?.type ?? null,
      team: goal?.team?.shortName || goal?.team?.name || null,
      teamId: goal?.team?.id ?? null,
    };
  });
}

function buildCards(match: any) {
  const bookings = Array.isArray(match?.bookings) ? match.bookings : [];

  return bookings.map((booking: any) => {
    const raw = String(booking?.card || "").toUpperCase();

    return {
      minute: formatMinute(booking?.minute),
      playerName: booking?.player?.name || "Joueur",
      player: booking?.player ?? null,
      card: raw.includes("RED") ? "RED" : "YELLOW",
      team: booking?.team?.shortName || booking?.team?.name || null,
      teamId: booking?.team?.id ?? null,
    };
  });
}

function buildSubstitutions(match: any) {
  const substitutions = Array.isArray(match?.substitutions)
    ? match.substitutions
    : [];

  return substitutions.map((sub: any) => ({
    minute: formatMinute(sub?.minute),
    playerInName: sub?.playerIn?.name || "",
    playerOutName: sub?.playerOut?.name || "",
    playerIn: sub?.playerIn ?? null,
    playerOut: sub?.playerOut ?? null,
    team: sub?.team?.shortName || sub?.team?.name || null,
    teamId: sub?.team?.id ?? null,
  }));
}

export async function GET() {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json(
        { error: "FOOTBALL_DATA_API_KEY manquante" },
        { status: 500 }
      );
    }

    const today = new Date();

    const from = new Date(today);
    from.setDate(from.getDate() - 7);

    const to = new Date(today);
    to.setDate(to.getDate() + 7);

    const data = await footballData(
      `/teams/${PSG_ID}/matches` +
        `?dateFrom=${getDateString(from)}` +
        `&dateTo=${getDateString(to)}` +
        `&limit=20`
    );

    const matches = Array.isArray(data?.matches) ? data.matches : [];

    if (matches.length === 0) {
      return NextResponse.json({ liveScore: null });
    }

    const liveMatches = matches.filter(
      (match: any) => match?.status === "IN_PLAY" || match?.status === "PAUSED"
    );

    const finishedMatches = matches
      .filter((match: any) => match?.status === "FINISHED")
      .sort(
        (a: any, b: any) =>
          new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime()
      );

    const upcomingMatches = matches
      .filter(
        (match: any) => match?.status === "SCHEDULED" || match?.status === "TIMED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime()
      );

    const listMatch =
      liveMatches[0] || finishedMatches[0] || upcomingMatches[0];

    if (!listMatch) {
      return NextResponse.json({ liveScore: null });
    }

    // La liste des matchs ne contient NI les buteurs, NI les cartons,
    // NI les changements : il faut demander le détail du match.
    let match = listMatch;

    if (listMatch.status !== "SCHEDULED" && listMatch.status !== "TIMED") {
      try {
        const detail = await footballData(`/matches/${listMatch.id}`);
        match = { ...listMatch, ...detail };
      } catch {
        // En cas d'échec, on garde les informations de base.
        match = listMatch;
      }
    }

    const score = getScore(match);
    const isPsgHome = String(match?.homeTeam?.id) === PSG_ID;

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

    const isLive = match?.status === "IN_PLAY" || match?.status === "PAUSED";

    let minute: string | null = null;
    let minuteEstimated = false;

    if (isLive) {
      minute = formatMinute(match?.minute, match?.injuryTime);

      if (!minute) {
        minute = estimateMinute(match);
        minuteEstimated = minute !== null;
      }
    }

    let matchStatus = "UPCOMING";

    if (isLive) {
      matchStatus = "LIVE";
    } else if (match.status === "FINISHED") {
      matchStatus = "FINISHED";
    }

    const liveScore = {
      competition: match?.competition?.name || "Football",

      status:
        match?.status === "FINISHED"
          ? "Terminé"
          : match?.status === "IN_PLAY"
            ? "En direct"
            : match?.status === "PAUSED"
              ? "Mi-temps"
              : "À venir",

      minute,
      minuteEstimated,

      homeTeam: homeTeam.name,
      awayTeam: awayTeam.name,

      homeLogo: homeTeam.logo,
      awayLogo: awayTeam.logo,

      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,

      homeScore: score.home,
      awayScore: score.away,

      isLive,
      isPsgHome,

      goals: buildGoals(match),
      cards: buildCards(match),
      substitutions: buildSubstitutions(match),

      events: [],

      kickoff: match?.utcDate || null,

      matchStatus,

      venue: match?.venue || null,
      matchday: match?.matchday || null,
      stage: match?.stage || null,

      lastUpdated: new Date().toISOString(),
    };

    return NextResponse.json(
      { liveScore },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error: any) {
    console.error("Live score error:", error);

    return NextResponse.json(
      {
        error:
          error?.status === 429
            ? "Trop de requêtes vers la source de données, réessayez dans un instant"
            : "Erreur serveur lors de la récupération du score",
      },
      { status: typeof error?.status === "number" ? error.status : 500 }
    );
  }
}
