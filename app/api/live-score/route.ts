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

    // On regarde suffisamment loin dans le passé et le futur
    // pour toujours retrouver le dernier match terminé ou le prochain.
    const dateFrom = new Date(now.getTime() - 7 * 86400000)
      .toISOString()
      .slice(0, 10);

    const dateTo = new Date(now.getTime() + 7 * 86400000)
      .toISOString()
      .slice(0, 10);

    const res = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      {
        headers: {
          "X-Auth-Token": API_KEY,
        },

        // Très important :
        // on ne veut pas que Vercel nous renvoie une ancienne réponse.
        cache: "no-store",
      }
    );

    if (!res.ok) {
      return NextResponse.json({
        liveScore: null,
        error: "API indisponible",
      });
    }

    const data = await res.json();

    const matches = Array.isArray(data.matches)
      ? data.matches
      : [];

    if (matches.length === 0) {
      return NextResponse.json({
        liveScore: null,
      });
    }

    /*
     * ============================================================
     * 1. MATCH EN DIRECT
     * ============================================================
     */

    const liveMatches = matches
      .filter(
        (match: any) =>
          match.status === "IN_PLAY" ||
          match.status === "PAUSED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() -
          new Date(b.utcDate).getTime()
      );

    /*
     * ============================================================
     * 2. DERNIER MATCH TERMINÉ
     * ============================================================
     */

    const finishedMatches = matches
      .filter(
        (match: any) =>
          match.status === "FINISHED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(b.utcDate).getTime() -
          new Date(a.utcDate).getTime()
      );

    /*
     * ============================================================
     * 3. PROCHAIN MATCH
     * ============================================================
     */

    const upcomingMatches = matches
      .filter(
        (match: any) =>
          match.status === "SCHEDULED" ||
          match.status === "TIMED"
      )
      .sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() -
          new Date(b.utcDate).getTime()
      );

    /*
     * ============================================================
     * PRIORITÉ
     *
     * DIRECT
     *    ↓
     * DERNIER MATCH TERMINÉ
     *    ↓
     * PROCHAIN MATCH
     *
     * Cela évite que le match terminé soit remplacé par
     * un ancien objet "À venir".
     * ============================================================
     */

    const match =
      liveMatches[0] ??
      finishedMatches[0] ??
      upcomingMatches[0];

    if (!match) {
      return NextResponse.json({
        liveScore: null,
      });
    }

    /*
     * ============================================================
     * ÉQUIPE DOMICILE / EXTÉRIEUR
     * ============================================================
     */

    const isHome =
      String(match.homeTeam?.id) === PSG_TEAM_ID;

    const isLive =
      match.status === "IN_PLAY" ||
      match.status === "PAUSED";

    /*
     * ============================================================
     * SCORE
     * ============================================================
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
     * ============================================================
     * MINUTE
     * ============================================================
     */

    const minute = calculateMatchMinute(
      match.utcDate,
      match.status
    );

    /*
     * ============================================================
     * BUTS
     * ============================================================
     */

    const goals = Array.isArray(match.goals)
      ? match.goals
          .filter(
            (goal: any) =>
              goal?.scorer?.name
          )
          .map((goal: any) => ({
            team:
              goal.team?.name ??
              goal.team?.shortName ??
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
     * ============================================================
     * RÉPONSE
     * ============================================================
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

          // On utilise name avant shortName pour éviter
          // "Sl. Bratislava" lorsqu'un nom complet est disponible.
          homeTeam:
            match.homeTeam?.name ??
            match.homeTeam?.shortName ??
            "Équipe domicile",

          awayTeam:
            match.awayTeam?.name ??
            match.awayTeam?.shortName ??
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
            "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
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
 * ================================================================
 * STATUT FOOTBALL-DATA → STATUT AFFICHABLE
 * ================================================================
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
 * ================================================================
 * MINUTE D'UN BUT
 * ================================================================
 */

function getGoalMinute(goal: any) {
  if (
    goal?.minute?.inPlay != null
  ) {
    return Number(
      goal.minute.inPlay
    );
  }

  if (
    goal?.minute?.extraTime != null
  ) {
    return Number(
      goal.minute.extraTime
    );
  }

  if (
    typeof goal?.minute === "number"
  ) {
    return goal.minute;
  }

  if (
    typeof goal?.minute === "string"
  ) {
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
 * ================================================================
 * CALCUL DE LA MINUTE DU MATCH
 * ================================================================
 */

function calculateMatchMinute(
  utcDate: string | null,
  status: string
) {
  if (!utcDate) {
    return null;
  }

  /*
   * Mi-temps
   */
  if (status === "PAUSED") {
    return 45;
  }

  /*
   * Pas de minute si le match n'est pas en direct.
   */
  if (status !== "IN_PLAY") {
    return null;
  }

  const kickoff =
    new Date(utcDate);

  if (
    Number.isNaN(
      kickoff.getTime()
    )
  ) {
    return null;
  }

  const elapsedMinutes =
    (Date.now() -
      kickoff.getTime()) /
    60000;

  if (elapsedMinutes < 0) {
    return 0;
  }

  /*
   * Première période
   */
  if (elapsedMinutes <= 45) {
    return Math.floor(
      elapsedMinutes
    );
  }

  /*
   * Environ 15 minutes de pause.
   */
  const secondHalfElapsed =
    elapsedMinutes - 60;

  if (
    secondHalfElapsed < 0
  ) {
    return 45;
  }

  /*
   * Deuxième période
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
