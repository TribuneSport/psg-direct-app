import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY!;
const PSG_TEAM_ID = "524";
const CRON_SECRET = process.env.CRON_SECRET!;

// GET /api/cron/check-score?secret=xxx
//
// Vérifie le score du PSG et envoie une notification
// lorsqu'un nouveau but est détecté.

export async function GET(req: NextRequest) {
  try {
    /*
     * ============================================================
     * SÉCURITÉ
     * ============================================================
     */

    const secret =
      req.nextUrl.searchParams.get("secret");

    if (secret !== CRON_SECRET) {
      return NextResponse.json(
        {
          error: "non autorisé",
        },
        {
          status: 401,
        }
      );
    }

    if (!API_KEY) {
      return NextResponse.json({
        checked: false,
        reason:
          "FOOTBALL_DATA_API_KEY absente",
      });
    }

    /*
     * ============================================================
     * PÉRIODE DE RECHERCHE
     * ============================================================
     *
     * On regarde J-1 / J+1 pour la vérification du match.
     */

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

    /*
     * ============================================================
     * FOOTBALL-DATA
     * ============================================================
     */

    const res = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      {
        headers: {
          "X-Auth-Token": API_KEY,
        },

        cache: "no-store",
      }
    );

    if (!res.ok) {
      return NextResponse.json({
        checked: false,
        reason: "API indisponible",
      });
    }

    const data = await res.json();

    const matches = Array.isArray(
      data.matches
    )
      ? data.matches
      : [];

    if (matches.length === 0) {
      return NextResponse.json({
        checked: true,
        match: false,
      });
    }

    /*
     * ============================================================
     * CHOIX DU BON MATCH
     * ============================================================
     *
     * Même logique que /api/live-score :
     *
     * 1. Match en direct
     * 2. Dernier match terminé
     * 3. Prochain match
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

    const match =
      liveMatches[0] ??
      finishedMatches[0] ??
      upcomingMatches[0];

    if (!match) {
      return NextResponse.json({
        checked: true,
        match: false,
      });
    }

    /*
     * ============================================================
     * ÉQUIPES
     * ============================================================
     */

    const homeTeam =
      match.homeTeam?.name ??
      match.homeTeam?.shortName ??
      "Équipe domicile";

    const awayTeam =
      match.awayTeam?.name ??
      match.awayTeam?.shortName ??
      "Équipe extérieure";

    const isPsgHome =
      String(match.homeTeam?.id) ===
      PSG_TEAM_ID;

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
     * ÉTAT PRÉCÉDENT
     * ============================================================
     */

    const previous =
      await prisma.matchState.findUnique({
        where: {
          id: "current",
        },
      });

    /*
     * ============================================================
     * PREMIÈRE VÉRIFICATION
     * ============================================================
     *
     * On crée simplement la référence du score.
     *
     * Aucune notification au démarrage.
     */

    if (!previous) {
      await prisma.matchState.upsert({
        where: {
          id: "current",
        },

        update: {
          homeScore,
          awayScore,
          status: match.status,
        },

        create: {
          id: "current",
          homeScore,
          awayScore,
          status: match.status,
        },
      });

      return NextResponse.json({
        checked: true,
        notified: false,
        reason: "baseline",
      });
    }

    /*
     * ============================================================
     * PROTECTION CONTRE LES FAUX RETOURS À 0-0
     * ============================================================
     *
     * Si le dernier état connu était un match terminé avec
     * un score différent de 0-0, on ne l'écrase pas avec
     * une réponse incohérente 0-0 / SCHEDULED / TIMED.
     */

    const previousWasFinished =
      previous.status === "FINISHED";

    const previousHadScore =
      previous.homeScore !== 0 ||
      previous.awayScore !== 0;

    const incomingIsUpcoming =
      match.status === "SCHEDULED" ||
      match.status === "TIMED";

    const incomingIsZeroZero =
      homeScore === 0 &&
      awayScore === 0;

    if (
      previousWasFinished &&
      previousHadScore &&
      incomingIsUpcoming &&
      incomingIsZeroZero
    ) {
      return NextResponse.json({
        checked: true,
        notified: false,
        ignored: true,
        reason:
          "ancienne donnée 0-0 ignorée",
      });
    }

    /*
     * ============================================================
     * DÉTECTION DU CHANGEMENT DE SCORE
     * ============================================================
     */

    const scoreChanged =
      previous.homeScore !== homeScore ||
      previous.awayScore !== awayScore;

    /*
     * ============================================================
     * SI LE SCORE A CHANGÉ
     * ============================================================
     */

    if (scoreChanged) {
      /*
       * ==========================================================
       * IDENTIFICATION DE L'ÉQUIPE QUI A MARQUÉ
       * ==========================================================
       */

      const psgScored = isPsgHome
        ? homeScore > previous.homeScore
        : awayScore > previous.awayScore;

      /*
       * ==========================================================
       * BUTS FOURNIS PAR FOOTBALL-DATA
       * ==========================================================
       */

      const goals = Array.isArray(
        match.goals
      )
        ? match.goals
        : [];

      /*
       * On récupère le dernier but connu.
       */

      const lastGoal =
        goals.length > 0
          ? goals[goals.length - 1]
          : null;

      /*
       * ==========================================================
       * BUTEUR
       * ==========================================================
       */

      const scorer =
        lastGoal?.scorer?.name ??
        null;

      /*
       * ==========================================================
       * MINUTE
       * ==========================================================
       */

      const goalMinute =
        getGoalMinute(lastGoal);

      /*
       * ==========================================================
       * TITRE DE NOTIFICATION
       * ==========================================================
       */

      let title = psgScored
        ? "⚽ BUT DU PSG !"
        : "⚽ But encaissé";

      /*
       * ==========================================================
       * CORPS DE NOTIFICATION
       * ==========================================================
       */

      let body = "";

      if (scorer && goalMinute != null) {
        body = `${scorer} - ${goalMinute}'\n${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
      } else if (scorer) {
        body = `${scorer}\n${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
      } else if (goalMinute != null) {
        body = `${goalMinute}'\n${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
      } else {
        body = `${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`;
      }

      /*
       * ==========================================================
       * ENVOI
       * ==========================================================
       */

      await sendPushToAll(
        title,
        body
      );

      /*
       * ==========================================================
       * SAUVEGARDE DU NOUVEAU SCORE
       * ==========================================================
       */

      await prisma.matchState.update({
        where: {
          id: "current",
        },

        data: {
          homeScore,
          awayScore,
          status: match.status,
        },
      });

      return NextResponse.json({
        checked: true,
        notified: true,

        notification: {
          title,
          body,
          scorer,
          minute: goalMinute,
          psgScored,
        },
      });
    }

    /*
     * ============================================================
     * PAS DE CHANGEMENT DE SCORE
     * ============================================================
     *
     * On met simplement à jour le statut.
     */

    await prisma.matchState.update({
      where: {
        id: "current",
      },

      data: {
        status: match.status,
      },
    });

    return NextResponse.json({
      checked: true,
      notified: false,
      scoreChanged: false,
      status: match.status,
    });
  } catch (error) {
    console.error(
      "Erreur check-score:",
      error
    );

    return NextResponse.json(
      {
        checked: false,
        error: "Erreur serveur",
      },
      {
        status: 500,
      }
    );
  }
}

/*
 * ================================================================
 * MINUTE DU BUT
 * ================================================================
 */

function getGoalMinute(
  goal: any
) {
  if (!goal) {
    return null;
  }

  if (
    goal.minute?.inPlay != null
  ) {
    return Number(
      goal.minute.inPlay
    );
  }

  if (
    goal.minute?.extraTime != null
  ) {
    return Number(
      goal.minute.extraTime
    );
  }

  if (
    typeof goal.minute === "number"
  ) {
    return goal.minute;
  }

  if (
    typeof goal.minute === "string"
  ) {
    const parsed =
      parseInt(
        goal.minute,
        10
      );

    if (
      !Number.isNaN(parsed)
    ) {
      return parsed;
    }
  }

  return null;
}

/*
 * ================================================================
 * ENVOI DES NOTIFICATIONS
 * ================================================================
 */

async function sendPushToAll(
  title: string,
  body: string
) {
  const tokens =
    await prisma.deviceToken.findMany({
      select: {
        token: true,
      },
    });

  if (
    tokens.length === 0
  ) {
    return;
  }

  const messages =
    tokens.map(
      (token) => ({
        to: token.token,
        title,
        body,
        sound: "default",
      })
    );

  /*
   * Expo limite les envois à 100 messages par requête.
   */

  for (
    let i = 0;
    i < messages.length;
    i += 100
  ) {
    const chunk =
      messages.slice(
        i,
        i + 100
      );

    await fetch(
      "https://exp.host/--/api/v2/push/send",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify(
          chunk
        ),
      }
    );
  }
}
