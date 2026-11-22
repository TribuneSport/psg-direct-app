import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const HIGHLIGHTLY_API_KEY = process.env.HIGHLIGHTLY_API_KEY;

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


// Football-Data.org (offre gratuite) : ces compétitions.
const FOOTBALL_DATA_CODES: Record<string, string> = {
  "ligue-1": "FL1",
  "champions-league": "CL",
  "premier-league": "PL",
  "la-liga": "PD",
  "serie-a": "SA",
  "bundesliga": "BL1",
};

// Highlightly : la Ligue 2 (absente de l'offre gratuite Football-Data).
const HIGHLIGHTLY_LEAGUES: Record<string, { name: string; countryCode: string }> = {
  "ligue-2": { name: "Ligue 2", countryCode: "FR" },
  "ligue2": { name: "Ligue 2", countryCode: "FR" },
};

type Row = {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  logo?: string;
};

function pick(...values: any[]) {
  return values.find((v) => v !== undefined && v !== null);
}

/* ---------------- Football-Data.org ---------------- */

async function fromFootballData(code: string): Promise<Row[]> {
  const data = await cached<any>(`fd-standings:${code}`, 300, async () => {
    const response = await fetch(
      `https://api.football-data.org/v4/competitions/${code}/standings`,
      {
        headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(`Football-Data ${response.status}`);
    }

    return response.json();
  });
  const groups = Array.isArray(data?.standings) ? data.standings : [];
  const total = groups.find((g: any) => g?.type === "TOTAL") || groups[0];
  const table = Array.isArray(total?.table) ? total.table : [];

  return table.map((row: any) => ({
    position: row?.position,
    team: row?.team?.shortName || row?.team?.name || "Équipe inconnue",
    played: row?.playedGames ?? 0,
    won: row?.won ?? 0,
    drawn: row?.draw ?? 0,
    lost: row?.lost ?? 0,
    goalsFor: row?.goalsFor ?? 0,
    goalsAgainst: row?.goalsAgainst ?? 0,
    points: row?.points ?? 0,
    logo: row?.team?.crest ?? undefined,
  }));
}

/* ---------------- Highlightly ---------------- */

async function highlightly(path: string, ttlSeconds: number) {
  return cached<any>(`hl:${path}`, ttlSeconds, async () => {
    const response = await fetch(`${HIGHLIGHTLY_URL}${path}`, {
      headers: { "x-rapidapi-key": HIGHLIGHTLY_API_KEY as string },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Highlightly ${response.status}`);
    }

    return response.json();
  });
}

function asList(json: any): any[] {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

// Saison en cours : de juillet à décembre = année en cours, sinon année - 1.
function currentSeason() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

async function findLeague(name: string, countryCode: string, debug: any) {
  const json = await highlightly(
    `/football/leagues?leagueName=${encodeURIComponent(name)}&countryCode=${countryCode}&limit=20`,
    86400
  );
  debug.leagues = json;

  const leagues = asList(json);
  const wanted = name.toLowerCase();

  return (
    leagues.find(
      (l: any) =>
        String(l?.name || "").toLowerCase() === wanted &&
        /fr/i.test(String(l?.country?.code || l?.countryCode || "FR"))
    ) || leagues.find((l: any) => String(l?.name || "").toLowerCase() === wanted)
  );
}

function parseHighlightlyRows(json: any): Row[] {
  const groups = Array.isArray(json?.groups) ? json.groups : [];
  const rows: any[] =
    groups[0]?.standings ||
    json?.standings ||
    asList(json)[0]?.standings ||
    asList(json) ||
    [];

  return (Array.isArray(rows) ? rows : []).map((row: any, index: number) => {
    const total = row?.total || row?.overall || row;

    return {
      position: pick(row?.position, row?.rank, index + 1),
      team:
        row?.team?.name ||
        row?.team?.displayName ||
        (typeof row?.team === "string" ? row.team : null) ||
        "Équipe inconnue",
      played: pick(total?.games_played, total?.played, total?.matches, 0),
      won: pick(total?.wins, total?.won, 0),
      drawn: pick(total?.draws, total?.drawn, 0),
      lost: pick(total?.loses, total?.losses, total?.lost, 0),
      goalsFor: pick(total?.scored_goals, total?.goalsFor, total?.goals_for, 0),
      goalsAgainst: pick(
        total?.received_goals,
        total?.goalsAgainst,
        total?.goals_against,
        0
      ),
      points: pick(row?.points, total?.points, 0),
      logo: row?.team?.logo || row?.team?.crest || undefined,
    };
  });
}

async function fromHighlightly(
  league: { name: string; countryCode: string },
  debug: any
): Promise<Row[]> {
  const found = await findLeague(league.name, league.countryCode, debug);

  if (!found?.id) {
    throw new Error("Ligue introuvable chez Highlightly");
  }

  const json = await highlightly(
    `/football/standings?leagueId=${found.id}&season=${currentSeason()}`,
    3600 // le classement change seulement après les matchs : 1 requête par heure
  );
  debug.standings = json;

  return parseHighlightlyRows(json);
}

/* ---------------- Route ---------------- */

// GET /api/standings?competition=ligue-1
// Ajoutez &debug=1 pour voir les réponses brutes des API (aide au réglage).
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("competition") || "ligue-1";
  const wantsDebug = request.nextUrl.searchParams.get("debug") === "1";
  const debug: any = {};

  try {
    let standings: Row[] = [];

    if (FOOTBALL_DATA_CODES[slug]) {
      if (!FOOTBALL_DATA_API_KEY) {
        return NextResponse.json(
          { standings: [], error: "FOOTBALL_DATA_API_KEY manquante" },
          { status: 500 }
        );
      }
      standings = await fromFootballData(FOOTBALL_DATA_CODES[slug]);
    } else if (HIGHLIGHTLY_LEAGUES[slug]) {
      if (!HIGHLIGHTLY_API_KEY) {
        return NextResponse.json(
          { standings: [], error: "HIGHLIGHTLY_API_KEY manquante" },
          { status: 500 }
        );
      }
      standings = await fromHighlightly(HIGHLIGHTLY_LEAGUES[slug], debug);
    } else {
      return NextResponse.json(
        { standings: [], error: "Classement non disponible pour cette compétition." },
        { status: 404 }
      );
    }

    return NextResponse.json(wantsDebug ? { standings, debug } : { standings });
  } catch (error: any) {
    console.error("Standings error:", error);
    return NextResponse.json(
      {
        standings: [],
        error: "Classement indisponible",
        ...(wantsDebug ? { detail: String(error?.message || error), debug } : {}),
      },
      { status: 502 }
    );
  }
}
