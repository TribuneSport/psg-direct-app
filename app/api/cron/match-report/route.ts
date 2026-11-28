import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// true  = les articles sont publiés tout de suite
// false = ils arrivent en brouillon, à relire dans le backoffice
const AUTO_PUBLISH = true;

const CRON_SECRET = process.env.CRON_SECRET;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const HIGHLIGHTLY_API_KEY = process.env.HIGHLIGHTLY_API_KEY;

const PSG_ID = "524";
const GEMINI_MODEL = "gemini-2.5-flash";

/* ---------------- Utilitaires ---------------- */import { NextRequest, NextResponse } from "next/server";

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
        // Chez Highlightly, "player" est le joueur qui SORT et "substituted" celui qui ENTRE.
        playerInName: personName(event?.substituted ?? event?.playerIn),
        playerOutName: personName(event?.player ?? event?.playerOut),
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

    // "Penalty" = penalty transformé. "VAR Penalty" (décision) et "Missed Penalty" ne sont pas des buts.
    const isPenaltyGoal = type === "penalty";

    if (
      isPenaltyGoal ||
      (type.includes("goal") &&
        !type.includes("disallow") &&
        !type.includes("cancel") &&
        !type.includes("miss"))
    ) {
      let playerName = personName(event?.player) || "But";
      if (type.includes("own")) playerName += " (c.s.c.)";
      else if (type.includes("penalt")) playerName += " (pen.)";

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


function teamLabel(team: any) {
  return team?.shortName || team?.name || "Équipe";
}

function parisDateTime(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "full",
    timeStyle: "short",
  });
}

function parisDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function psgResult(match: any) {
  const home = match.score?.fullTime?.home;
  const away = match.score?.fullTime?.away;
  if (typeof home !== "number" || typeof away !== "number") return null;

  const psgHome = String(match.homeTeam?.id) === PSG_ID;
  const mine = psgHome ? home : away;
  const theirs = psgHome ? away : home;

  return {
    psgGoals: mine,
    opponentGoals: theirs,
    result: mine > theirs ? "victoire" : mine < theirs ? "défaite" : "match nul",
  };
}

/* ---------------- Football-Data ---------------- */

async function footballData(path: string) {
  const response = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY as string },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Football-Data ${response.status}`);
  }

  return response.json();
}

async function standingOf(competitionCode: string | undefined, teamId: number | string) {
  // Le classement n'est ajouté que pour la Ligue 1.
  if (competitionCode !== "FL1") return null;

  try {
    const data = await footballData("/competitions/FL1/standings");
    const total = (data?.standings || []).find((s: any) => s?.type === "TOTAL");
    const row = (total?.table || []).find((r: any) => String(r?.team?.id) === String(teamId));

    return row
      ? { rang: row.position, points: row.points, matchs_joues: row.playedGames }
      : null;
  } catch {
    return null;
  }
}

/* ---------------- Highlightly (buteurs, cartons, changements) ---------------- */

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

function personName(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value?.name || value?.displayName || "";
}

async function loadEvents(match: any) {
  if (!HIGHLIGHTLY_API_KEY) return null;

  try {
    const list = await highlightly(
      `/football/matches?date=${parisDay(match.utcDate)}&timezone=Europe%2FParis` +
        `&leagueName=${encodeURIComponent(match.competition?.name || "")}&limit=50`
    );

    const found = asList(list).find(
      (m: any) =>
        /paris|psg/i.test(String(m?.homeTeam?.name || "")) ||
        /paris|psg/i.test(String(m?.awayTeam?.name || ""))
    );

    if (!found?.id) return null;

    const events = asList(await highlightly(`/football/events/${found.id}`));

    const buts: any[] = [];
    const cartons: any[] = [];
    const changements: any[] = [];

    for (const event of events) {
      const type = String(event?.type ?? event?.event ?? event?.detail ?? "").toLowerCase();
      const minute = event?.time ?? event?.minute ?? null;
      const equipe = event?.team?.name || null;

      if (type.includes("sub")) {
        changements.push({
          minute,
          entrant: personName(event?.player ?? event?.playerIn),
          sortant: personName(event?.substituted ?? event?.playerOut ?? event?.assist),
          equipe,
        });
      } else if (type.includes("red") || type.includes("yellow")) {
        cartons.push({
          minute,
          joueur: personName(event?.player),
          carton: type.includes("red") ? "rouge" : "jaune",
          equipe,
        });
      } else if (
        type.includes("goal") &&
        !type.includes("disallow") &&
        !type.includes("cancel") &&
        !type.includes("miss")
      ) {
        buts.push({
          minute,
          buteur: personName(event?.player),
          passeur: personName(event?.assist) || null,
          type: type.includes("own") ? "contre son camp" : type.includes("pen") ? "penalty" : "but",
          equipe,
        });
      }
    }

    return { buts, cartons, changements };
  } catch (error) {
    console.error("Highlightly events error:", error);
    return null;
  }
}

/* ---------------- Gemini ---------------- */

async function writeArticle(kind: "report" | "preview", facts: any) {
  const instructions =
    kind === "report"
      ? "Rédige le compte rendu du match (3 à 4 paragraphes) : déroulé et résultat, puis ce qu'il implique au classement si l'information est fournie."
      : "Rédige l'avant-match (3 paragraphes) : enjeu du match, contexte sportif (classement, forme récente) si fournis, informations pratiques (date, heure, stade). N'annonce aucun pronostic de score ni aucune composition.";

  const prompt = `Tu es journaliste sportif pour une application de fans du Paris Saint-Germain.
${instructions}

RÈGLES STRICTES :
- Utilise UNIQUEMENT les faits du JSON ci-dessous.
- N'invente aucun buteur, aucune minute, aucune statistique, aucune citation, aucune blessure.
- Si une information n'est pas dans le JSON, ne la mentionne pas.
- Ton factuel et vivant, en français, sans emoji.
- Le titre ne contient pas la mention "IA".
- "excerpt" : une phrase factuelle de 25 mots maximum.

Réponds UNIQUEMENT avec un JSON : {"title": "...", "excerpt": "...", "content": "..."}
Dans "content", sépare les paragraphes par une ligne vide.

FAITS :
${JSON.stringify(facts, null, 2)}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const json = await response.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

  if (!parsed?.title || !parsed?.content) {
    throw new Error("Réponse Gemini incomplète");
  }

  return parsed as { title: string; excerpt?: string; content: string };
}

async function saveArticle(key: string, article: { title: string; excerpt?: string; content: string }) {
  const title = `${article.title.trim()} (IA)`;

  return prisma.article.create({
    data: {
      title,
      slug: `${slugify(article.title)}-${Date.now().toString(36)}`,
      content: article.content.trim(),
      excerpt: article.excerpt?.trim() || null,
      club: "PSG",
      status: AUTO_PUBLISH ? "PUBLISHED" : "DRAFT",
      isAiGenerated: true,
      sourceUrl: key,
      publishedAt: AUTO_PUBLISH ? new Date() : null,
    },
    select: { id: true, title: true, status: true },
  });
}

/* ---------------- Route ---------------- */

// GET /api/cron/match-report?secret=...
// À appeler toutes les 30 minutes. Crée AU PLUS UN article par appel :
// d'abord le compte rendu d'un match terminé, sinon l'avant-match.
export async function GET(request: NextRequest) {
  if (!CRON_SECRET || request.nextUrl.searchParams.get("secret") !== CRON_SECRET) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  if (!FOOTBALL_DATA_API_KEY || !GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "FOOTBALL_DATA_API_KEY ou GEMINI_API_KEY manquante" },
      { status: 500 }
    );
  }

  try {
    const now = Date.now();
    const from = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date(now + 4 * 86400000).toISOString().slice(0, 10);

    const data = await footballData(`/teams/${PSG_ID}/matches?dateFrom=${from}&dateTo=${to}&limit=40`);
    const matches: any[] = Array.isArray(data?.matches) ? data.matches : [];

    const finished = matches
      .filter((m) => m.status === "FINISHED")
      .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

    const recentForm = (excludeId: number) =>
      finished
        .filter((m) => m.id !== excludeId && new Date(m.utcDate).getTime() < now)
        .slice(0, 5)
        .map((m) => {
          const r = psgResult(m);
          return `${teamLabel(m.homeTeam)} ${m.score?.fullTime?.home}-${m.score?.fullTime?.away} ${teamLabel(m.awayTeam)} (${r?.result ?? "?"}, ${m.competition?.name ?? ""})`;
        });

    /* 1) Compte rendu d'un match terminé depuis moins de 72 h */
    for (const match of finished) {
      if (now - new Date(match.utcDate).getTime() > 72 * 3600000) break;

      const key = `psgdirect:report:${match.id}`;
      if (await prisma.article.findUnique({ where: { sourceUrl: key }, select: { id: true } })) {
        continue;
      }

      const result = psgResult(match);
      if (!result) continue;

      const events = await loadEvents(match);

      const facts = {
        competition: match.competition?.name,
        journee: match.matchday ?? null,
        phase: match.stage ?? null,
        date: parisDateTime(match.utcDate),
        stade: match.venue ?? null,
        domicile: teamLabel(match.homeTeam),
        exterieur: teamLabel(match.awayTeam),
        score_final: `${match.score?.fullTime?.home}-${match.score?.fullTime?.away}`,
        score_mi_temps:
          typeof match.score?.halfTime?.home === "number"
            ? `${match.score.halfTime.home}-${match.score.halfTime.away}`
            : null,
        resultat_du_psg: result.result,
        buts: events?.buts ?? "non disponible",
        cartons: events?.cartons ?? "non disponible",
        changements: events?.changements ?? "non disponible",
        classement_psg_actuel: await standingOf(match.competition?.code, PSG_ID),
        forme_recente_psg: recentForm(match.id),
      };

      const article = await writeArticle("report", facts);
      const saved = await saveArticle(key, article);

      return NextResponse.json({ ok: true, type: "report", article: saved });
    }

    /* 2) Avant-match d'un match prévu dans les 36 prochaines heures */
    const upcoming = matches
      .filter((m) => m.status === "SCHEDULED" || m.status === "TIMED")
      .sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime())[0];

    if (upcoming && new Date(upcoming.utcDate).getTime() - now < 36 * 3600000) {
      const key = `psgdirect:preview:${upcoming.id}`;
      const exists = await prisma.article.findUnique({ where: { sourceUrl: key }, select: { id: true } });

      if (!exists) {
        const psgHome = String(upcoming.homeTeam?.id) === PSG_ID;
        const opponent = psgHome ? upcoming.awayTeam : upcoming.homeTeam;

        const facts = {
          competition: upcoming.competition?.name,
          journee: upcoming.matchday ?? null,
          phase: upcoming.stage ?? null,
          date_et_heure: parisDateTime(upcoming.utcDate),
          stade: upcoming.venue ?? null,
          domicile: teamLabel(upcoming.homeTeam),
          exterieur: teamLabel(upcoming.awayTeam),
          classement_psg: await standingOf(upcoming.competition?.code, PSG_ID),
          classement_adversaire: await standingOf(upcoming.competition?.code, opponent?.id),
          forme_recente_psg: recentForm(upcoming.id),
        };

        const article = await writeArticle("preview", facts);
        const saved = await saveArticle(key, article);

        return NextResponse.json({ ok: true, type: "preview", article: saved });
      }
    }

    return NextResponse.json({ ok: true, created: null, message: "Rien à écrire pour le moment" });
  } catch (error: any) {
    console.error("Match report error:", error);
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
