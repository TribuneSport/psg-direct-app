import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY!;
const PSG_TEAM_ID = "524";
const CRON_SECRET = process.env.CRON_SECRET!;

// GET /api/cron/check-score?secret=xxx
//
// Appelée toutes les minutes par un service externe (cron-job.org) pendant
// les heures de match. Compare le score actuel avec le dernier score connu
// (stocké dans MatchState) ; si ça a changé, envoie une notification push
// à tous les téléphones enregistrés.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: "non autorisé" }, { status: 401 });
  }

  const today = new Date();
  const dateFrom = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  const dateTo = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

  const res = await fetch(
    `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    { headers: { "X-Auth-Token": API_KEY } }
  );
  if (!res.ok) return NextResponse.json({ checked: false, reason: "API indisponible" });

  const data = await res.json();
  const match = data.matches?.[0];
  if (!match) return NextResponse.json({ checked: true, match: false });

  const homeScore = match.score.fullTime.home ?? match.score.halfTime.home ?? 0;
  const awayScore = match.score.fullTime.away ?? match.score.halfTime.away ?? 0;
  const homeTeam = match.homeTeam.shortName ?? match.homeTeam.name;
  const awayTeam = match.awayTeam.shortName ?? match.awayTeam.name;
  const isPsgHome = match.homeTeam.id.toString() === PSG_TEAM_ID;

  const previous = await prisma.matchState.findUnique({ where: { id: "current" } });

  const scoreChanged = previous && (previous.homeScore !== homeScore || previous.awayScore !== awayScore);

  // Première vérification de la journée : on enregistre juste le score de
  // départ, sans notifier (sinon tout le monde recevrait une fausse alerte
  // "but" dès le début du match).
  if (!previous || match.status === "SCHEDULED" || match.status === "TIMED") {
    await prisma.matchState.upsert({
      where: { id: "current" },
      update: { homeScore, awayScore, status: match.status },
      create: { id: "current", homeScore, awayScore, status: match.status },
    });
    return NextResponse.json({ checked: true, notified: false, reason: "baseline" });
  }

  if (scoreChanged) {
    const psgScored = isPsgHome ? homeScore > previous.homeScore : awayScore > previous.awayScore;
    const title = psgScored ? "⚽ BUT DU PSG !" : "⚽ But encaissé";
    const body = `${homeTeam} ${homeScore} — ${awayScore} ${awayTeam}`;

    await sendPushToAll(title, body);

    await prisma.matchState.update({
      where: { id: "current" },
      data: { homeScore, awayScore, status: match.status },
    });

    return NextResponse.json({ checked: true, notified: true });
  }

  // Pas de changement, mais on met quand même à jour le statut (ex: passage
  // à "Terminé") pour rester synchronisé.
  await prisma.matchState.update({ where: { id: "current" }, data: { status: match.status } });
  return NextResponse.json({ checked: true, notified: false });
}

async function sendPushToAll(title: string, body: string) {
  const tokens = await prisma.deviceToken.findMany({ select: { token: true } });
  if (tokens.length === 0) return;

  const messages = tokens.map((t) => ({
    to: t.token,
    title,
    body,
    sound: "default",
  }));

  // Expo limite à 100 notifications par appel : on découpe si besoin.
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
  }
}
