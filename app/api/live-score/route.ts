import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const HIGHLIGHTLY_API_KEY = process.env.HIGHLIGHTLY_API_KEY;

const PSG_ID = "524";
const FOOTBALL_DATA_URL = "https://api.football-data.org/v4";
const HIGHLIGHTLY_URL = "https://sports.highlightly.net";

/* ---------------- Cache partagé (Upstash Redis + mémoire) ----------------
   Évite de dépasser les quotas des API gratuites : un seul appel externe
   sert tous les téléphones pendant la durée indiquée. */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const memoryCache = new Map<string, { expires: number; value: any }>();

async function redisCommand(command: (string | number)[]) {
  const response = await fetch(REDIS_URL as string, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const json = await response.json();
  if (json?.error) throw new Error(json.error);
  return json?.result;
}

async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const fullKey = `psg:cache:${key}`;
  const now = Date.now();

  const inMemory = memoryCache.get(fullKey);
  if (inMemory && inMemory.expires > now) {
    return inMemory.value as T;
  }

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const raw = await redisCommand(["GET", fullKey]);
      if (raw) {
        const value = JSON.parse(raw);
        memoryCache.set(fullKey, { expires: now + 10_000, value });
        return value as T;
      }
    } catch {
      /* Redis indisponible : on continue sans cache partagé */
    }
  }

  const value = await loader();
  // Un échec (null) n'est gardé que 60 secondes pour réessayer vite.
  const ttl = value === null ? Math.min(ttlSeconds, 60) : ttlSeconds;

  memoryCache.set(fullKey, { expires: now + ttl * 1000, value });

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await redisCommand(["SET", fullKey, JSON.stringify(value), "EX", ttl]);
    } catch {
      /* ignoré */
    }
  }

  return value;
}

/* ---------------- Football-Data.org (score, statut) ---------------- */

function getDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getTeamName(team: any) {
  return team?.name || team?.shortName || team?.tla || "Équipe inconnue";
}

function getScore(match: any) {
  const fullTime = match?.score?.fullTime;

  return {
    home: typeof fullTime?.home === "number" ? fullTime.home : 0,
    away: typeof fullTime?.away === "number" ? fullTime.away : 0,
  };
}

async function footballData(path: string) {
  const response = await fetch(`${FOOTBALL_DATA_URL}${path}`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
    cache: "no-store",
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

// Minute estimée à partir du coup d'envoi (l'offre gratuite ne la fournit pas).
function estimateMinute(match: any): string | null {
  if (match?.status === "PAUSED") return "MT";
  if (match?.status !== "IN_PLAY" || !match?.utcDate) return null;

  const elapsed = Math.floor((Date.now() - new Date(match.utcDate).getTime()) / 60000);
  if (elapsed < 0) return null;

  const minute = elapsed <= 45 ? Math.max(elapsed, 1) : Math.max(46, elapsed - 15);
  return minute > 90 ? "90+'" : `${minute}'`;
}

/* ---------------- Highlightly (buteurs, cartons, changements) ---------------- */

async function highlightly(path: string) {
  const response = await fetch(`${HIGHLIGHTLY_URL}${path}`, {
    headers: { "x-rapidapi-key": HIGHLIGHTLY_API_KEY as string },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Highlightly ${response.status}`);
  }

  return response.json();
}

function asList(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

function parisDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}

const PSG_NAME = /paris|psg/i;

// Retrouve l'identifiant Highlightly du match du PSG (1 requête, gardée en cache).
async function findHighlightlyMatchId(match: any, debug: any): Promise<number | null> {
  const date = parisDate(match.utcDate);
  const leagueName = match?.competition?.name || "";

  return cached<number | null>(
    `hl-match-id:${match.id}`,
    6 * 3600,
    async () => {
      try {
        const json = await highlightly(
          `/football/matches?date=${date}&timezone=Europe%2FParis` +
            `&leagueName=${encodeURIComponent(leagueName)}&limit=50`
        );
        debug.matches = json;

        const found = asList(json).find(
          (m: any) =>
            PSG_NAME.test(String(m?.homeTeam?.name || "")) ||
            PSG_NAME.test(String(m?.awayTeam?.name || ""))
        );

        return found?.id ?? null;
      } catch (error) {
        console.error("Highlightly lookup error:", error);
        return null;
      }
    }
  );
}

function personName(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value?.name || value?.displayName || "";
}

function eventMinute(event: any): string | null {
  const raw = event?.time ?? event?.minute ?? event?.elapsed;
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw);
  return text.includes("'") ? text : `${text}'`;
}

function buildEvents(events: any[]) {
  const goals: any[] = [];
  const cards: any[] = [];
  const substitutions: any[] = [];

  for (const event of events) {
    const type = String(event?.type ?? event?.event ?? event?.detail ?? "").toLowerCase();
    const minute = eventMinute(event);
    const team = event?.team?.name || null;

    if (type.includes("sub")) {
      substitutions.push({
        minute,
        playerInName: personName(event?.player ?? event?.playerIn),
        playerOutName: personName(event?.substituted ?? event?.playerOut ?? event?.assist),
        team,
      });
      continue;
    }

    if (type.includes("red") || type.includes("yellow")) {
      cards.push({
        minute,
        playerName: personName(event?.player) || "Joueur",
        card: type.includes("red") ? "RED" : "YELLOW",
        team,
      });
      continue;
    }

    if (
      type.includes("goal") &&
      !type.includes("disallow") &&
      !type.includes("cancel") &&
      !type.includes("miss")
    ) {
      let playerName = personName(event?.player) || "But";
      if (type.includes("own")) playerName += " (c.s.c.)";
      else if (type.includes("pen")) playerName += " (pen.)";

      goals.push({ minute, playerName, assist: personName(event?.assist) || null, team });
    }
  }

  return { goals, cards, substitutions };
}

async function loadHighlightlyEvents(match: any, isLive: boolean, debug: any) {
  if (!HIGHLIGHTLY_API_KEY) return null;

  const id = await findHighlightlyMatchId(match, debug);
  if (!id) return null;

  // En direct : rafraîchi toutes les 90 s (≈ 80 requêtes pour un match entier,
  // pour un quota de 100/jour). Match terminé : toutes les heures.
  const json = await cached<any>(`hl-events:${id}`, isLive ? 90 : 3600, async () => {
    try {
      return await highlightly(`/football/events/${id}`);
    } catch (error) {
      console.error("Highlightly events error:", error);
      return null;
    }
  });

  debug.events = json;
  if (!json) return null;

  return buildEvents(asList(json));
}

/* ---------------- Route ---------------- */

// GET /api/live-score   (ajoutez ?debug=1 pour voir les réponses brutes de Highlightly)
export async function GET(request: NextRequest) {
  const wantsDebug = request.nextUrl.searchParams.get("debug") === "1";
  const debug: any = {};

  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json({ error: "FOOTBALL_DATA_API_KEY manquante" }, { status: 500 });
    }

    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - 7);
    const to = new Date(today);
    to.setDate(to.getDate() + 7);

    const data = await cached<any>("fd-psg-matches", 20, () =>
      footballData(
        `/teams/${PSG_ID}/matches?dateFrom=${getDateString(from)}&dateTo=${getDateString(to)}&limit=20`
      )
    );

    const matches = Array.isArray(data?.matches) ? data.matches : [];

    if (matches.length === 0) {
      return NextResponse.json({ liveScore: null });
    }

    const liveMatches = matches.filter(
      (m: any) => m?.status === "IN_PLAY" || m?.status === "PAUSED"
    );

    const finishedMatches = matches
      .filter((m: any) => m?.status === "FINISHED")
      .sort((a: any, b: any) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

    const upcomingMatches = matches
      .filter((m: any) => m?.status === "SCHEDULED" || m?.status === "TIMED")
      .sort((a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());

    const match = liveMatches[0] || finishedMatches[0] || upcomingMatches[0];

    if (!match) {
      return NextResponse.json({ liveScore: null });
    }

    const score = getScore(match);
    const isLive = match.status === "IN_PLAY" || match.status === "PAUSED";
    const hasStarted = isLive || match.status === "FINISHED";

    let goals: any[] = [];
    let cards: any[] = [];
    let substitutions: any[] = [];
    let eventsSource: string | null = null;

    if (hasStarted) {
      const events = await loadHighlightlyEvents(match, isLive, debug);

      if (events) {
        goals = events.goals;
        cards = events.cards;
        substitutions = events.substitutions;
        eventsSource = "highlightly";
      }
    }

    const minute = isLive ? estimateMinute(match) : null;

    const liveScore = {
      competition: match?.competition?.name || "Football",

      status:
        match.status === "FINISHED"
          ? "Terminé"
          : match.status === "IN_PLAY"
            ? "En direct"
            : match.status === "PAUSED"
              ? "Mi-temps"
              : "À venir",

      minute,
      minuteEstimated: minute !== null,

      homeTeam: getTeamName(match?.homeTeam),
      awayTeam: getTeamName(match?.awayTeam),

      homeLogo: match?.homeTeam?.crest || null,
      awayLogo: match?.awayTeam?.crest || null,

      homeTeamId: match?.homeTeam?.id ?? null,
      awayTeamId: match?.awayTeam?.id ?? null,

      homeScore: score.home,
      awayScore: score.away,

      isLive,
      isPsgHome: String(match?.homeTeam?.id) === PSG_ID,

      goals,
      cards,
      substitutions,
      eventsSource,

      events: [],

      kickoff: match?.utcDate || null,

      matchStatus: isLive ? "LIVE" : match.status === "FINISHED" ? "FINISHED" : "UPCOMING",

      venue: match?.venue || null,
      matchday: match?.matchday || null,
      stage: match?.stage || null,

      lastUpdated: new Date().toISOString(),
    };

    return NextResponse.json(
      wantsDebug ? { liveScore, debug } : { liveScore },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
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
