import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const HIGHLIGHTLY_API_KEY = process.env.HIGHLIGHTLY_API_KEY;
const PSG_ID = "524";
const PSG_NAME = /paris|psg/i;

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

async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  nullTtlSeconds = 60
): Promise<T> {
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
  // Un échec (null) est gardé moins longtemps, pour réessayer sans gaspiller les quotas.
  const ttl = value === null ? Math.min(ttlSeconds, nullTtlSeconds) : ttlSeconds;

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

/* ---------------- Football-Data : choix du match ---------------- */

function getDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function loadMatches() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 7);
  const to = new Date(today);
  to.setDate(to.getDate() + 7);

  // Même clé de cache que /api/live-score : un seul appel pour les deux routes.
  return cached<any>("fd-psg-matches", 20, async () => {
    const response = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_ID}/matches?dateFrom=${getDateString(from)}&dateTo=${getDateString(to)}&limit=20`,
      { headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string }, cache: "no-store" }
    );

    if (!response.ok) throw new Error(`Football-Data ${response.status}`);
    return response.json();
  });
}

/* ---------------- Highlightly ---------------- */

async function highlightly(path: string) {
  const response = await fetch(`https://sports.highlightly.net${path}`, {
    headers: { "x-rapidapi-key": HIGHLIGHTLY_API_KEY as string },
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Highlightly ${response.status}`);
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

async function findHighlightlyMatchId(match: any): Promise<number | null> {
  return cached<number | null>(
    `hl-match-id:${match.id}`,
    6 * 3600,
    async () => {
      try {
        const json = await highlightly(
          `/football/matches?date=${parisDate(match.utcDate)}&timezone=Europe%2FParis` +
            `&leagueName=${encodeURIComponent(match?.competition?.name || "")}&limit=50`
        );

        const found = asList(json).find(
          (m: any) =>
            PSG_NAME.test(String(m?.homeTeam?.name || "")) ||
            PSG_NAME.test(String(m?.awayTeam?.name || ""))
        );

        return found?.id ?? null;
      } catch {
        return null;
      }
    },
    600
  );
}

/* ---------------- Compositions ---------------- */

function toPlayers(list: any): any[] {
  if (!Array.isArray(list)) return [];

  return list
    .flatMap((item: any) => (Array.isArray(item) ? item : [item]))
    .map((p: any) => ({
      name: typeof p === "string" ? p : p?.name || p?.displayName || "",
      number: p?.number ?? p?.shirtNumber ?? p?.jerseyNumber ?? null,
      position: p?.position ?? null,
    }))
    .filter((p: any) => p.name);
}

function parseLineupSide(side: any) {
  if (!side) return null;

  const initial = side?.initialLineup ?? side?.startingXI ?? side?.starters ?? side?.lineup;

  // Highlightly renvoie les titulaires ligne par ligne : gardien, défense, milieu, attaque.
  const rows =
    Array.isArray(initial) && initial.every((row: any) => Array.isArray(row))
      ? initial.map((row: any) => toPlayers(row)).filter((row: any[]) => row.length > 0)
      : [];

  return {
    formation: side?.formation ?? null,
    rows,
    starters: toPlayers(initial),
    substitutes: toPlayers(side?.substitutes ?? side?.bench),
  };
}

function parseLineups(json: any) {
  const root = Array.isArray(json?.data) ? json.data[0] : json?.data ?? (Array.isArray(json) ? json[0] : json);
  const home = parseLineupSide(root?.homeTeam ?? root?.home);
  const away = parseLineupSide(root?.awayTeam ?? root?.away);

  if (!home?.starters.length && !away?.starters.length) return null;
  return { home, away };
}

/* ---------------- Statistiques (bilan de fin de match) ---------------- */

type StatSpec = {
  label: string;
  names: string[];
  mode: "int" | "dec" | "pct" | "sum" | "ratio";
};

const STAT_SPECS: StatSpec[] = [
  { label: "Possession", names: ["Possession"], mode: "pct" },
  { label: "Expected goals (xG)", names: ["Expected Goals"], mode: "dec" },
  { label: "Tirs", names: ["Shots on target", "Shots off target", "Blocked shots"], mode: "sum" },
  { label: "Tirs cadrés", names: ["Shots on target"], mode: "int" },
  { label: "Grosses occasions", names: ["Big Chances Created"], mode: "int" },
  { label: "Corners", names: ["Corners"], mode: "int" },
  { label: "Passes", names: ["Total passes"], mode: "int" },
  { label: "Passes réussies", names: ["Successful passes", "Total passes"], mode: "ratio" },
  { label: "Interceptions", names: ["Interceptions"], mode: "int" },
  { label: "Arrêts du gardien", names: ["Goalkeeper saves"], mode: "int" },
  { label: "Fautes", names: ["Fouls"], mode: "int" },
  { label: "Hors-jeu", names: ["Offsides"], mode: "int" },
  { label: "Cartons jaunes", names: ["Yellow cards"], mode: "int" },
  { label: "Cartons rouges", names: ["Red cards"], mode: "int" },
];

function statValue(entry: any, name: string): number | null {
  const stat = (entry?.statistics || []).find(
    (s: any) => String(s?.displayName ?? s?.name ?? "").toLowerCase() === name.toLowerCase()
  );
  if (!stat || stat.value === null || stat.value === undefined) return null;

  const n = Number(stat.value);
  return Number.isNaN(n) ? null : n;
}

function computeStat(entry: any, spec: StatSpec): string | null {
  const values = spec.names.map((name) => statValue(entry, name));

  if (spec.mode === "sum") {
    if (values.every((v) => v === null)) return null;
    return String(values.reduce((sum: number, v) => sum + (v ?? 0), 0));
  }

  if (spec.mode === "ratio") {
    const [done, total] = values;
    if (done === null || total === null || !total) return null;
    return `${Math.round((done / total) * 100)}%`;
  }

  const value = values[0];
  if (value === null) return null;

  if (spec.mode === "pct") return `${Math.round(value <= 1 ? value * 100 : value)}%`;
  if (spec.mode === "dec") return value.toFixed(2);
  return String(Math.round(value));
}

function parseStats(json: any, psgIsHome: boolean) {
  const entries = asList(json).filter((e: any) => Array.isArray(e?.statistics));
  if (entries.length < 2) return null;

  const psgEntry = entries.find((e: any) => PSG_NAME.test(String(e?.team?.name || ""))) ?? entries[0];
  const otherEntry = entries.find((e: any) => e !== psgEntry) ?? entries[1];
  const homeEntry = psgIsHome ? psgEntry : otherEntry;
  const awayEntry = psgIsHome ? otherEntry : psgEntry;

  const rows: Array<{ label: string; home: string; away: string }> = [];

  for (const spec of STAT_SPECS) {
    const home = computeStat(homeEntry, spec);
    const away = computeStat(awayEntry, spec);
    if (home !== null && away !== null) rows.push({ label: spec.label, home, away });
  }

  return rows.length ? rows : null;
}

/* ---------------- Route ---------------- */

// GET /api/match-center (ajoutez ?debug=1 pour voir les réponses brutes)
//
// Économie de requêtes Highlightly (100/jour en gratuit) :
//  - compositions : 1 requête, seulement dans l'heure qui précède le coup d'envoi ;
//  - statistiques : 1 requête, uniquement quand le match est terminé ;
//  - un échec n'est retenté que toutes les 5 à 10 minutes.
export async function GET(request: NextRequest) {
  const wantsDebug = request.nextUrl.searchParams.get("debug") === "1";
  const debug: any = {};

  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json({ error: "FOOTBALL_DATA_API_KEY manquante" }, { status: 500 });
    }

    const data = await loadMatches();
    const matches: any[] = Array.isArray(data?.matches) ? data.matches : [];

    const live = matches.find((m) => m.status === "IN_PLAY" || m.status === "PAUSED");
    const finished = matches
      .filter((m) => m.status === "FINISHED")
      .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime())[0];
    const upcoming = matches
      .filter((m) => m.status === "SCHEDULED" || m.status === "TIMED")
      .sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime())[0];

    const match = live || finished || upcoming;

    if (!match || !HIGHLIGHTLY_API_KEY) {
      return NextResponse.json({ matchCenter: null });
    }

    const phase = live ? "LIVE" : match.status === "FINISHED" ? "FINISHED" : "UPCOMING";
    const msToKickoff = new Date(match.utcDate).getTime() - Date.now();
    const psgIsHome = String(match?.homeTeam?.id) === PSG_ID;

    let lineups: any = null;
    let stats: any = null;

    // Compositions : seulement dans les 75 minutes avant le coup d'envoi, puis une fois pour toutes.
    if (phase !== "UPCOMING" || msToKickoff < 75 * 60000) {
      const id = await findHighlightlyMatchId(match);

      if (id) {
        lineups = await cached<any>(
          `hl-lineups-parsed:${id}`,
          12 * 3600,
          async () => {
            try {
              const json = await highlightly(`/football/lineups/${id}`);
              if (wantsDebug) debug.lineups = json;
              return parseLineups(json);
            } catch {
              return null;
            }
          },
          600
        );

        // Statistiques : une seule requête, une fois le match terminé.
        if (phase === "FINISHED") {
          stats = await cached<any>(
            `hl-stats-parsed:${id}`,
            24 * 3600,
            async () => {
              try {
                const json = await highlightly(`/football/statistics/${id}`);
                if (wantsDebug) debug.statistics = json;
                return parseStats(json, psgIsHome);
              } catch {
                return null;
              }
            },
            300
          );
        }
      }
    }

    const payload = {
      matchId: match.id,
      phase,
      homeTeam: match?.homeTeam?.shortName || match?.homeTeam?.name,
      awayTeam: match?.awayTeam?.shortName || match?.awayTeam?.name,
      lineups,
      stats,
    };

    return NextResponse.json(
      { matchCenter: payload, ...(wantsDebug ? { debug } : {}) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Match center error:", error);
    return NextResponse.json({ matchCenter: null, error: "Erreur serveur" }, { status: 500 });
  }
}
