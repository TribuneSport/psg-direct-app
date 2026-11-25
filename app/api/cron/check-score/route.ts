import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const PSG_ID = "524";

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

type State = { matchId: number; home: number; away: number; status: string };

async function redisCommand(command: (string | number)[]) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error("Stockage Redis non configuré");
  }

  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });

  const json = await response.json();
  if (json?.error) throw new Error(json.error);
  return json?.result;
}

function teamLabel(team: any) {
  return team?.shortName || team?.name || "Équipe";
}

async function sendPush(title: string, body: string) {
  const tokens: string[] = (await redisCommand(["SMEMBERS", "psg:push-tokens"])) ?? [];

  for (let i = 0; i < tokens.length; i += 100) {
    const chunk = tokens.slice(i, i + 100);

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(
        chunk.map((to) => ({
          to,
          title,
          body,
          sound: "default",
          channelId: "default",
          priority: "high",
        }))
      ),
    });

    const json = await response.json().catch(() => null);

    // Retire les téléphones où l'appli a été désinstallée.
    const results = Array.isArray(json?.data) ? json.data : [];
    for (let index = 0; index < results.length; index++) {
      if (results[index]?.details?.error === "DeviceNotRegistered") {
        await redisCommand(["SREM", "psg:push-tokens", chunk[index]]).catch(() => null);
      }
    }
  }

  return tokens.length;
}

// GET /api/push/check?secret=VOTRE_CRON_SECRET
// À appeler toutes les minutes par un cron externe (cron-job.org).
// Compare le score au précédent et envoie : coup d'envoi, buts, but annulé,
// mi-temps et fin de match.
export async function GET(request: NextRequest) {
  const secret =
    request.nextUrl.searchParams.get("secret") ||
    request.headers.get("authorization")?.replace("Bearer ", "");

  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  if (!FOOTBALL_DATA_API_KEY) {
    return NextResponse.json({ error: "FOOTBALL_DATA_API_KEY manquante" }, { status: 500 });
  }

  try {
    const day = 86400000;
    const from = new Date(Date.now() - day).toISOString().slice(0, 10);
    const to = new Date(Date.now() + day).toISOString().slice(0, 10);

    const response = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_ID}/matches?dateFrom=${from}&dateTo=${to}`,
      { headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY }, cache: "no-store" }
    );

    if (!response.ok) {
      return NextResponse.json({ ok: false, error: `Football-Data ${response.status}` });
    }

    const data = await response.json();
    const matches: any[] = Array.isArray(data?.matches) ? data.matches : [];

    const match =
      matches.find((m) => m.status === "IN_PLAY" || m.status === "PAUSED") ||
      [...matches]
        .filter((m) => m.status === "FINISHED")
        .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime())[0];

    if (!match) {
      return NextResponse.json({ ok: true, match: null });
    }

    const home = Number(match.score?.fullTime?.home ?? 0);
    const away = Number(match.score?.fullTime?.away ?? 0);
    const scoreText = `${teamLabel(match.homeTeam)} ${home} - ${away} ${teamLabel(match.awayTeam)}`;

    const raw = await redisCommand(["GET", "psg:last-state"]);
    const previous: State | null = raw ? JSON.parse(raw) : null;

    const current: State = { matchId: match.id, home, away, status: match.status };
    const sent: string[] = [];

    if (!previous) {
      // Première exécution : on mémorise sans notifier.
    } else if (previous.matchId !== match.id) {
      // Nouveau match : on prévient seulement si le coup d'envoi est récent.
      const minutesSinceKickoff = (Date.now() - new Date(match.utcDate).getTime()) / 60000;
      if (match.status === "IN_PLAY" && minutesSinceKickoff < 15) {
        await sendPush("⚽ Coup d'envoi", scoreText);
        sent.push("kickoff");
      }
    } else {
      const psgIsHome = String(match.homeTeam?.id) === PSG_ID;
      const before = previous.home + previous.away;
      const now = home + away;

      if (now > before) {
        const psgScored = psgIsHome ? home > previous.home : away > previous.away;
        await sendPush(psgScored ? "⚽ BUT du PSG !" : "⚽ But adverse", scoreText);
        sent.push("goal");
      } else if (now < before) {
        await sendPush("⚠️ But annulé", scoreText);
        sent.push("goal-cancelled");
      }

      if (previous.status === "IN_PLAY" && match.status === "PAUSED") {
        await sendPush("⏸ Mi-temps", scoreText);
        sent.push("half-time");
      }

      if (previous.status !== "FINISHED" && match.status === "FINISHED") {
        await sendPush("🏁 Match terminé", scoreText);
        sent.push("full-time");
      }
    }

    await redisCommand(["SET", "psg:last-state", JSON.stringify(current), "EX", 172800]);

    return NextResponse.json({ ok: true, status: match.status, score: scoreText, sent });
  } catch (error: any) {
    console.error("Push check error:", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
