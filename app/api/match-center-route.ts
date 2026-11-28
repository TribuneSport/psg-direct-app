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
  return cached<number | null>(`hl-match-id:${match.id}`, 6 * 3600, async () => {
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
  });
}

/* ---------------- Compositions ---------------- */

function personName(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value?.name || value?.displayName || "";
}

function toPlayers(list: any): any[] {
  if (!Array.isArray(list)) return [];

  // Certaines API renvoient les joueurs par lignes : on aplatit.
  const flat = list.flatMap((item: any) => (Array.isArray(item) ? item : [item]));

  return flat
    .map((p: any) => {
      const player = p?.player && typeof p.player === "object" ? { ...p, ...p.player } : p;
      return {
        name: personName(player?.name ? player : player?.player ?? player),
        number: player?.number ?? player?.shirtNumber ?? player?.jerseyNumber ?? null,
        position: player?.position ?? player?.pos ?? null,
      };
    })
    .filter((p: any) => p.name);
}

function parseLineupSide(side: any) {
  if (!side) return null;

  return {
    formation: side?.formation ?? null,
    starters: toPlayers(side?.startingXI ?? side?.initialLineup ?? side?.starters ?? side?.lineup),
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

/* ---------------- Statistiques ---------------- */

const STAT_LABELS: Array<[RegExp, string]> = [
  [/possession/i, "Possession"],
  [/on target|cadr/i, "Tirs cadrés"],
  [/shots|tirs/i, "Tirs"],
  [/corner/i, "Corners"],
  [/foul|faute/i, "Fautes"],
  [/offside|hors/i, "Hors-jeu"],
  [/yellow|jaune/i, "Cartons jaunes"],
  [/red card|rouge/i, "Cartons rouges"],
  [/pass/i, "Passes"],
  [/save|arr[eê]t/i, "Arrêts"],
];

function statLabel(raw: string) {
  const found = STAT_LABELS.find(([regex]) => regex.test(raw));
  return found ? found[1] : raw;
}

function parseStats(json: any, psgIsHome: boolean) {
  const entries = asList(json).filter((e: any) => Array.isArray(e?.statistics));
  if (entries.length < 2) return null;

  const psgEntry = entries.find((e: any) => PSG_NAME.test(String(e?.team?.name || ""))) ?? entries[0];
  const otherEntry = entries.find((e: any) => e !== psgEntry) ?? entries[1];
  const homeEntry = psgIsHome ? psgEntry : otherEntry;
  const awayEntry = psgIsHome ? otherEntry : psgEntry;

  const rows: Array<{ label: string; home: string; away: string }> = [];

  for (const stat of homeEntry.statistics) {
    const name = String(stat?.displayName ?? stat?.name ?? stat?.type ?? "");
    const other = awayEntry.statistics.find(
      (s: any) => String(s?.displayName ?? s?.name ?? s?.type ?? "") === name
    );

    if (!name || stat?.value === undefined || other?.value === undefined) continue;

    rows.push({ label: statLabel(name), home: String(stat.value), away: String(other.value) });
  }

  return rows.length ? rows.slice(0, 12) : null;
}

/* ---------------- Route ---------------- */

// GET /api/match-center (ajoutez ?debug=1 pour voir les réponses brutes)
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
    const isLive = Boolean(live);

    if (!match || !HIGHLIGHTLY_API_KEY) {
      return NextResponse.json({ matchCenter: null });
    }

    const id = await findHighlightlyMatchId(match);
    if (!id) return NextResponse.json({ matchCenter: null });

    const psgIsHome = String(match?.homeTeam?.id) === PSG_ID;

    // Quotas Highlightly (100 requêtes/jour en gratuit) : durées de cache volontairement longues.
    const lineupsJson = await cached<any>(`hl-lineups:${id}`, isLive ? 1800 : 6 * 3600, async () => {
      try {
        return await highlightly(`/football/lineups/${id}`);
      } catch {
        return null;
      }
    });

    const started = match.status === "IN_PLAY" || match.status === "PAUSED" || match.status === "FINISHED";

    const statsJson = started
      ? await cached<any>(`hl-stats:${id}`, isLive ? 300 : 3600, async () => {
          try {
            return await highlightly(`/football/statistics/${id}`);
          } catch {
            return null;
          }
        })
      : null;

    if (wantsDebug) {
      debug.lineups = lineupsJson;
      debug.statistics = statsJson;
    }

    const lineups = lineupsJson ? parseLineups(lineupsJson) : null;
    const stats = statsJson ? parseStats(statsJson, psgIsHome) : null;

    const payload = {
      matchId: match.id,
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
