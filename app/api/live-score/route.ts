import { NextResponse } from "next/server";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY!;
const PSG_TEAM_ID = "524";

export async function GET() {
  try {
    if (!API_KEY) {
      return NextResponse.json({
        liveScore: null,
        error: "Clé FOOTBALL_DATA_API_KEY absente",
      });
    }

    const now = new Date();

    const dateFrom = new Date(
      now.getTime() - 86400000
    )
      .toISOString()
      .slice(0, 10);

    const dateTo = new Date(
      now.getTime() + 86400000
    )
      .toISOString()
      .slice(0, 10);

    const res = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      {
        headers: {
          "X-Auth-Token": API_KEY,
        },
        next: {
          revalidate: 15,
        },
      }
    );

    if (!res.ok) {
      return NextResponse.json({
        liveScore: null,
        error: "API indisponible",
      });
    }

    const data = await res.json();

    const matches = data.matches ?? [];

    /*
     * On cherche d'abord un match actuellement en direct.
     */
    const liveMatch = matches.find(
      (match: any) =>
        match.status === "IN_PLAY" ||
        match.status === "PAUSED"
    );

    /*
     * Si aucun match n'est en direct,
     * on prend le match le plus proche.
     */
    const match =
      liveMatch ??
      [...matches].sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() -
          new Date(b.utcDate).getTime()
      )[0];

    if (!match) {
      return NextResponse.json({
        liveScore: null,
      });
    }

    const isHome =
      String(match.homeTeam?.id) === PSG_TEAM_ID;

    const isLive =
      match.status === "IN_PLAY" ||
      match.status === "PAUSED";

    /*
     * SCORE
     */
    const homeScore =
      match.score?.fullTime?.home ??
      match.score?.halfTime?.home ??
      0;

    const awayScore =
      match.score?.fullTime?.away ??
      match.score?.halfTime?.away ??
      0;

    /*
     * MINUTE DU MATCH
     *
     * Football-Data ne fournit pas toujours
     * la minute en direct.
     *
     * On la calcule donc à partir du coup d'envoi.
     */
    const minute = calculateMatchMinute(
      match.utcDate,
      match.status
    );

    /*
     * BUTS
     */
    const goals = Array.isArray(match.goals)
      ? match.goals
          .filter(
            (goal: any) =>
              goal?.scorer?.name
          )
          .map((goal: any) => ({
            team:
              goal.team?.shortName ??
              goal.team?.name ??
              null,

            player:
              goal.scorer?.name ??
              null,

            minute:
              getGoalMinute(goal),

            assist:
              goal.assist?.name ??
              null,

            type:
              goal.type ??
              null,
          }))
      : [];

    /*
     * RÉPONSE
     */
    return NextResponse.json(
      {
        liveScore: {
          competition:
            match.competition?.name ??
            "Football",

          status:
            mapStatus(match.status),

          minute,

          homeTeam:
            match.homeTeam?.shortName ??
            match.homeTeam?.name ??
            "Équipe domicile",

          awayTeam:
            match.awayTeam?.shortName ??
            match.awayTeam?.name ??
            "Équipe extérieure",

          homeScore,

          awayScore,

          isLive,

          isPsgHome: isHome,

          goals,

          kickoff:
            match.utcDate ??
            null,

          matchStatus:
            match.status ??
            null,

          lastUpdated:
            new Date().toISOString(),
        },
      },
      {
        headers: {
          "Cache-Control":
            "s-maxage=15, stale-while-revalidate=15",
        },
      }
    );
  } catch (error) {
    console.error(
      "Erreur live-score:",
      error
    );

    return NextResponse.json({
      liveScore: null,
      error: "Erreur réseau",
    });
  }
}

/*
 * Conversion du statut Football-Data
 * vers un statut affichable.
 */
function mapStatus(status: string) {
  const map: Record<string, string> = {
    SCHEDULED: "À venir",
    TIMED: "À venir",
    IN_PLAY: "En direct",
    PAUSED: "Mi-temps",
    FINISHED: "Terminé",
    POSTPONED: "Reporté",
    CANCELLED: "Annulé",
    SUSPENDED: "Suspendu",
  };

  return map[status] ?? status;
}

/*
 * Récupération de la minute d'un but.
 */
function getGoalMinute(goal: any) {
  if (goal?.minute?.inPlay != null) {
    return Number(
      goal.minute.inPlay
    );
  }

  if (goal?.minute?.extraTime != null) {
    return Number(
      goal.minute.extraTime
    );
  }

  if (typeof goal?.minute === "number") {
    return goal.minute;
  }

  if (typeof goal?.minute === "string") {
    const parsed = parseInt(
      goal.minute,
      10
    );

    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

/*
 * Calcul de la minute du match.
 */
function calculateMatchMinute(
  utcDate: string | null,
  status: string
) {
  if (!utcDate) {
    return null;
  }

  if (status === "PAUSED") {
    return 45;
  }

  if (status !== "IN_PLAY") {
    return null;
  }

  const kickoff = new Date(
    utcDate
  );

  if (Number.isNaN(kickoff.getTime())) {
    return null;
  }

  const now = new Date();

  const elapsedMinutes =
    (now.getTime() -
      kickoff.getTime()) /
    60000;

  if (elapsedMinutes < 0) {
    return 0;
  }

  /*
   * Première mi-temps
   */
  if (elapsedMinutes <= 45) {
    return Math.floor(
      elapsedMinutes
    );
  }

  /*
   * Mi-temps supposée :
   * on retire environ 15 minutes.
   */
  const secondHalfElapsed =
    elapsedMinutes - 60;

  if (secondHalfElapsed < 0) {
    return 45;
  }

  /*
   * Deuxième mi-temps
   */
  const minute =
    45 +
    Math.floor(
      secondHalfElapsed
    );

  return Math.min(
    minute,
    120
  );
}
