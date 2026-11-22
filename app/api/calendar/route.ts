import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const PSG_ID = "524";

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

// Saison en cours : de juillet à décembre = année en cours, sinon année - 1.
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

// GET /api/calendar — tous les matchs de la saison (passés avec score, à venir)
export async function GET() {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json(
        { matches: [], error: "FOOTBALL_DATA_API_KEY manquante" },
        { status: 500 }
      );
    }

    const data = await cached<any>("fd-psg-season", 600, async () => {
      const response = await fetch(
        `https://api.football-data.org/v4/teams/${PSG_ID}/matches?season=${currentSeason()}&limit=100`,
        {
          headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
          cache: "no-store",
        }
      );

      if (!response.ok) {
        console.error("Calendar API error:", response.status, await response.text());
        return null;
      }

      return response.json();
    });

    if (!data) {
      return NextResponse.json(
        { matches: [], error: "Calendrier indisponible" },
        { status: 502 }
      );
    }

    const matches = (Array.isArray(data?.matches) ? data.matches : [])
      .sort(
        (a: any, b: any) =>
          new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime()
      )
      .map((m: any) => ({
        id: m.id,
        date: m.utcDate,
        status: m.status,
        competition: {
          id: m.competition?.id ?? null,
          name: m.competition?.name,
          code: m.competition?.code ?? null,
          emblem: m.competition?.emblem ?? null,
        },
        homeTeam: {
          id: m.homeTeam?.id ?? null,
          name: m.homeTeam?.name,
          shortName: m.homeTeam?.shortName,
          crest: m.homeTeam?.crest ?? null,
        },
        awayTeam: {
          id: m.awayTeam?.id ?? null,
          name: m.awayTeam?.name,
          shortName: m.awayTeam?.shortName,
          crest: m.awayTeam?.crest ?? null,
        },
        score: {
          home: m.score?.fullTime?.home ?? null,
          away: m.score?.fullTime?.away ?? null,
        },
        venue: m.venue ?? null,
        matchday: m.matchday ?? null,
      }));

    return NextResponse.json({ matches });
  } catch (error) {
    console.error("Calendar error:", error);
    return NextResponse.json(
      { matches: [], error: "Erreur serveur" },
      { status: 500 }
    );
  }
}
