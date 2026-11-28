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

function frenchPosition(position: string | null | undefined): { label: string; order: number } {
  const p = String(position || "").toLowerCase();

  if (p.includes("goal")) return { label: "Gardien", order: 1 };
  if (p.includes("back") || p.includes("defen")) return { label: "Défenseur", order: 2 };
  if (p.includes("midfield")) return { label: "Milieu", order: 3 };
  if (p.includes("wing") || p.includes("forward") || p.includes("offen") || p.includes("attack")) {
    return { label: "Attaquant", order: 4 };
  }

  return { label: position || "Poste non renseigné", order: 5 };
}

// GET /api/players?club=PSG — effectif (écran « Équipe », onglet Joueurs)
export async function GET() {
  try {
    if (!FOOTBALL_DATA_API_KEY) {
      return NextResponse.json({ error: "FOOTBALL_DATA_API_KEY manquante" }, { status: 500 });
    }

    const team = await cached<any>("fd-team-psg", 6 * 3600, async () => {
      const response = await fetch(`https://api.football-data.org/v4/teams/${PSG_ID}`, {
        headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
        cache: "no-store",
      });

      if (!response.ok) {
        console.error("Team API error:", response.status);
        return null;
      }

      return response.json();
    });

    if (!team) {
      return NextResponse.json({ players: [], error: "Effectif indisponible" }, { status: 502 });
    }

    const players = (Array.isArray(team.squad) ? team.squad : [])
      .map((p: any) => {
        const position = frenchPosition(p.position);
        return {
          id: p.id,
          name: p.name,
          position: position.label,
          order: position.order,
          number: null,
          nationality: p.nationality ?? null,
        };
      })
      .sort((a: any, b: any) => a.order - b.order || String(a.name).localeCompare(String(b.name)))
      .map(({ order, ...player }: any) => player);

    return NextResponse.json({ players });
  } catch (error) {
    console.error("Players error:", error);
    return NextResponse.json({ players: [], error: "Erreur serveur" }, { status: 500 });
  }
}
