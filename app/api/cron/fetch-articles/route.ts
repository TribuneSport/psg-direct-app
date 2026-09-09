import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/* =========================================================
   CONFIGURATION
========================================================= */

const RSS_FEEDS = [
  {
    name: "Google News",
    url: "https://news.google.com/rss/search?q=PSG+Paris+Saint-Germain+football&hl=fr&gl=FR&ceid=FR:fr",
  },
  {
    name: "RMC Sport",
    url: "https://rmcsport.bfmtv.com/rss/football/",
  },
  {
    name: "Foot Mercato",
    url: "https://www.footmercato.net/rss",
  },
  {
    name: "CulturePSG",
    url: "https://www.culturepsg.com/news?rss",
  },
];

const MAX_ITEMS_PER_SOURCE = 25;

const DAILY_TARGET = 20;
const MAX_NEW_ARTICLES_PER_RUN = 5;
const MAX_SOURCES_PER_ARTICLE = 5;

const RSS_TIMEOUT_MS = 4000;
const SOURCE_TIMEOUT_MS = 3000;
const GEMINI_TIMEOUT_MS = 8000;

const MIN_ARTICLE_WORDS = 400;
const TARGET_ARTICLE_WORDS = 600;
const MAX_ARTICLE_WORDS = 900;

const LOW_INFORMATION_WORDS = 110;
const MAX_SOURCE_PAGE_CHARS = 6500;

const CLUSTER_SIMILARITY_THRESHOLD = 0.48;

/* =========================================================
   TYPES
========================================================= */

type FeedItem = {
  title: string;
  description: string;
  source: string;
  link: string;
  pubDate: string;
};

type ArticleInput = {
  title: string;
  description: string;
  source: string;
  link: string;
};

type GeminiArticle = {
  title: string;
  excerpt: string;
  content: string;
};

type Diagnostic = {
  cluster: number;
  sources: string[];
  titles: string[];
  outcome: string;
  detail: string;
};

type EnrichmentResult = {
  sources: ArticleInput[];
  pagesFetched: number;
  pagesFailed: number;
  enrichedCharacters: number;
  pageErrors: string[];
};

type GeminiCallResult = {
  article: GeminiArticle | null;
  error: string | null;
  quotaExceeded: boolean;
};

type ProcessClusterResult = {
  created: boolean;
  articleTitle?: string;
  sourceUrl?: string | null;

  geminiCalls: number;
  geminiSuccess: number;
  geminiErrors: string[];

  invalidJson: number;
  tooShort: number;
  tooShortAfterRetry: number;
  slugErrors: number;
  createErrors: number;

  enrichment: EnrichmentResult;
  diagnostic: Diagnostic;
};

/* =========================================================
   GET
========================================================= */

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  try {
    /* -----------------------------------------------------
       AUTHENTIFICATION
    ----------------------------------------------------- */

    const authHeader = req.headers.get("authorization");

    if (
      !CRON_SECRET ||
      authHeader !== `Bearer ${CRON_SECRET}`
    ) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        {
          status: 401,
        }
      );
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json(
        {
          error: "GEMINI_API_KEY is not configured",
        },
        {
          status: 500,
        }
      );
    }

    /* -----------------------------------------------------
       RSS
    ----------------------------------------------------- */

    const rssResults = await Promise.all(
      RSS_FEEDS.map((feed) =>
        fetchRssFeed(feed.name, feed.url)
      )
    );

    const allItems: FeedItem[] = [];
    const rssErrors: string[] = [];

    for (const result of rssResults) {
      if (result.error) {
        rssErrors.push(result.error);
      }

      allItems.push(...result.items);
    }

    /* -----------------------------------------------------
       FILTRE PSG
    ----------------------------------------------------- */

    const psgItems = allItems.filter((item) =>
      isRelevantToPSG(item)
    );

    /* -----------------------------------------------------
       DEDUPLICATION RSS
    ----------------------------------------------------- */

    const uniqueItems = deduplicateFeedItems(psgItems);

    const recentItems = uniqueItems
      .sort(
        (a, b) =>
          getTimestamp(b.pubDate) -
          getTimestamp(a.pubDate)
      )
      .slice(0, 150);

    /* -----------------------------------------------------
       ARTICLES EXISTANTS
    ----------------------------------------------------- */

    const recentArticles =
      await prisma.article.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: 150,
        select: {
          title: true,
          slug: true,
          sourceUrl: true,
        },
      });

    /* -----------------------------------------------------
       NOUVEAUX ITEMS
    ----------------------------------------------------- */

    const newItems = recentItems.filter(
      (item) =>
        !isAlreadyImported(
          item,
          recentArticles
        )
    );

    /* -----------------------------------------------------
       CLUSTERS
    ----------------------------------------------------- */

    const clusters =
      buildSimpleClusters(newItems);

    const candidateClusters =
      clusters.filter(
        (cluster) => cluster.length > 0
      );

    /* -----------------------------------------------------
       OBJECTIF JOURNALIER
    ----------------------------------------------------- */

    const startOfDay = new Date();

    startOfDay.setHours(
      0,
      0,
      0,
      0
    );

    const articlesCreatedToday =
      await prisma.article.count({
        where: {
          createdAt: {
            gte: startOfDay,
          },
        },
      });

    const remainingDailyTarget =
      Math.max(
        DAILY_TARGET -
          articlesCreatedToday,
        0
      );

    const numberToProcess =
      Math.min(
        MAX_NEW_ARTICLES_PER_RUN,
        remainingDailyTarget,
        candidateClusters.length
      );

    const selectedClusters =
      candidateClusters
        .sort(
          (a, b) =>
            getClusterPriority(b) -
            getClusterPriority(a)
        )
        .slice(
          0,
          numberToProcess
        );

    /* -----------------------------------------------------
       TRAITEMENT PARALLELE
    ----------------------------------------------------- */

    const results: ProcessClusterResult[] =
      await Promise.all(
        selectedClusters.map(
          (cluster, index) =>
            processCluster(
              cluster,
              recentArticles,
              index + 1
            )
        )
      );

    /* -----------------------------------------------------
       STATISTIQUES
    ----------------------------------------------------- */

    let created = 0;
    let skipped = 0;

    let geminiCalls = 0;
    let geminiSuccess = 0;

    let invalidJson = 0;
    let tooShort = 0;
    let tooShortAfterRetry = 0;
    let slugErrors = 0;
    let createErrors = 0;

    let sourcePagesFetched = 0;
    let sourcePagesFailed = 0;
    let enrichedCharacters = 0;

    const geminiErrors: string[] = [];
    const sourcePageErrors: string[] = [];

    const diagnostics: Diagnostic[] = [];

    for (const result of results) {
      if (result.created) {
        created++;
      } else {
        skipped++;
      }

      geminiCalls +=
        result.geminiCalls;

      geminiSuccess +=
        result.geminiSuccess;

      invalidJson +=
        result.invalidJson;

      tooShort +=
        result.tooShort;

      tooShortAfterRetry +=
        result.tooShortAfterRetry;

      slugErrors +=
        result.slugErrors;

      createErrors +=
        result.createErrors;

      sourcePagesFetched +=
        result.enrichment.pagesFetched;

      sourcePagesFailed +=
        result.enrichment.pagesFailed;

      enrichedCharacters +=
        result.enrichment.enrichedCharacters;

      geminiErrors.push(
        ...result.geminiErrors
      );

      sourcePageErrors.push(
        ...result.enrichment.pageErrors
      );

      diagnostics.push(
        result.diagnostic
      );
    }

    const elapsedMs =
      Date.now() - startedAt;

    return NextResponse.json({
      checked: recentItems.length,

      newItems:
        newItems.length,

      clusters:
        clusters.length,

      candidateClusters:
        candidateClusters.length,

      processedClusters:
        selectedClusters.length,

      deferred:
        Math.max(
          candidateClusters.length -
            selectedClusters.length,
          0
        ),

      created,

      skipped,

      articlesCreatedToday:
        articlesCreatedToday +
        created,

      dailyTarget:
        DAILY_TARGET,

      remainingDailyTarget:
        Math.max(
          DAILY_TARGET -
            (articlesCreatedToday +
              created),
          0
        ),

      dailyTargetReached:
        articlesCreatedToday +
          created >=
        DAILY_TARGET,

      sourcesOk: [
        "Google News",
        "RMC Sport",
        "CulturePSG",
      ],

      sources:
        RSS_FEEDS.map(
          (feed) =>
            feed.name
        ),

      duplicates:
        psgItems.length -
        uniqueItems.length,

      fusion: true,

      optimized: true,

      enrichment: true,

      simplified: true,

      unlimitedDailyCap: true,

      diagnostics: {
        geminiCalls,
        geminiSuccess,
        geminiErrors,

        invalidJson,
        tooShort,
        tooShortAfterRetry,
        slugErrors,
        createErrors,

        rssErrors,

        sourcePagesFetched,
        sourcePagesFailed,
        enrichedCharacters,

        sourcePageErrors,

        clusters:
          diagnostics,
      },

      elapsedMs,
    });
  } catch (error) {
    console.error(
      "PSG Direct cron error:",
      error
    );

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",

        elapsedMs:
          Date.now() - startedAt,
      },
      {
        status: 500,
      }
    );
  }
}

/* =========================================================
   RSS
========================================================= */

async function fetchRssFeed(
  source: string,
  url: string
): Promise<{
  items: FeedItem[];
  error: string | null;
}> {
  try {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        RSS_TIMEOUT_MS
      );

    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

          headers: {
            "User-Agent":
              "PSG-Direct/1.0",

            Accept:
              "application/rss+xml, application/xml, text/xml",
          },

          cache:
            "no-store",
        }
      );

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        items: [],
        error:
          `${source}: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const xml =
      await response.text();

    const items =
      parseRssXml(
        xml,
        source
      );

    return {
      items:
        items.slice(
          0,
          MAX_ITEMS_PER_SOURCE
        ),

      error: null,
    };
  } catch (error) {
    return {
      items: [],

      error:
        `${source}: ${
          error instanceof Error
            ? error.message
            : "Unknown RSS error"
        }`,
    };
  }
}

/* =========================================================
   RSS XML PARSER
========================================================= */

function parseRssXml(
  xml: string,
  source: string
): FeedItem[] {
  const items: FeedItem[] = [];

  const itemMatches =
    xml.match(
      /<item\b[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const itemXml of itemMatches
  ) {
    const title =
      cleanHtml(
        extractXmlValue(
          itemXml,
          "title"
        )
      );

    const description =
      cleanHtml(
        extractXmlValue(
          itemXml,
          "description"
        )
      );

    const link =
      extractXmlValue(
        itemXml,
        "link"
      ).trim();

    const pubDate =
      extractXmlValue(
        itemXml,
        "pubDate"
      ).trim();

    if (
      !title ||
      !link
    ) {
      continue;
    }

    items.push({
      title,
      description,
      source,
      link,
      pubDate,
    });
  }

  return items;
}

function extractXmlValue(
  xml: string,
  tag: string
): string {
  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(regex);

  return (
    match?.[1] || ""
  );
}

/* =========================================================
   PSG FILTER
========================================================= */

function isRelevantToPSG(
  item: FeedItem
): boolean {
  const text =
    normalizeText(
      `${item.title} ${item.description}`
    );

  const positiveTerms = [
    "psg",
    "paris saint germain",
    "paris saint-germain",
    "paris sg",
    "paris-sg",

    "donnarumma",
    "hakimi",
    "marquinhos",
    "nuno mendes",
    "vitinha",
    "joao neves",
    "dembele",
    "dembélé",
    "kvaratskhelia",
    "barcola",
    "doue",
    "doué",
    "desire doue",
    "desiré doué",
    "luis enrique",
  ];

  return positiveTerms.some(
    (term) =>
      text.includes(
        normalizeText(
          term
        )
      )
  );
}

/* =========================================================
   DEDUPLICATION
========================================================= */

function deduplicateFeedItems(
  items: FeedItem[]
): FeedItem[] {
  const map =
    new Map<
      string,
      FeedItem
    >();

  for (
    const item of items
  ) {
    const key =
      normalizeTitle(
        item.title
      );

    if (!key) {
      continue;
    }

    const existing =
      map.get(key);

    if (!existing) {
      map.set(
        key,
        item
      );

      continue;
    }

    if (
      getSourcePriority(
        item.source
      ) >
      getSourcePriority(
        existing.source
      )
    ) {
      map.set(
        key,
        item
      );
    }
  }

  return Array.from(
    map.values()
  );
}

/* =========================================================
   EXISTING ARTICLE CHECK
========================================================= */

function isAlreadyImported(
  item: FeedItem,
  articles: Array<{
    title: string;
    slug: string;
    sourceUrl: string | null;
  }>
): boolean {
  const normalizedTitle =
    normalizeTitle(
      item.title
    );

  const normalizedUrl =
    normalizeUrl(
      item.link
    );

  return articles.some(
    (article) => {
      if (
        normalizedUrl &&
        normalizeUrl(
          article.sourceUrl ||
            ""
        ) ===
          normalizedUrl
      ) {
        return true;
      }

      const existingTitle =
        normalizeTitle(
          article.title
        );

      return (
        existingTitle ===
        normalizedTitle
      );
    }
  );
}

/* =========================================================
   CLUSTERING
========================================================= */

type ClusterProfile = {
  opponents: string[];
  competitions: string[];
  topic: string;
  entities: string[];
  tokens: string[];
};

function buildSimpleClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters: FeedItem[][] = [];

  const sorted =
    [...items].sort(
      (a, b) =>
        getTimestamp(b.pubDate) -
        getTimestamp(a.pubDate)
    );

  for (const item of sorted) {
    let bestCluster: FeedItem[] | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = scoreItemAgainstCluster(item, cluster);

      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (
      bestCluster &&
      bestScore >= CLUSTER_SIMILARITY_THRESHOLD
    ) {
      bestCluster.push(item);
    } else {
      clusters.push([item]);
    }
  }

  return clusters;
}

/* =========================================================
   CLUSTER PROFILE
========================================================= */

function buildClusterProfile(
  items: FeedItem[]
): ClusterProfile {
  const opponents = new Set<string>();
  const competitions = new Set<string>();
  const entities = new Set<string>();
  const tokens = new Set<string>();

  for (const item of items) {
    for (const opponent of extractAllOpponents(item.title)) {
      opponents.add(opponent);
    }

    for (const competition of extractCompetitions(item.title)) {
      competitions.add(competition);
    }

    for (const entity of extractEntities(item.title)) {
      entities.add(entity);
    }

    for (const token of meaningfulTokens(item.title)) {
      tokens.add(token);
    }
  }

  return {
    opponents: Array.from(opponents),
    competitions: Array.from(competitions),
    topic: getTopicFamily(items[0]?.title || ''),
    entities: Array.from(entities),
    tokens: Array.from(tokens),
  };
}

/* =========================================================
   CLUSTER SCORE
========================================================= */

function scoreItemAgainstCluster(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  if (cluster.length === 0) {
    return 0;
  }

  const reference = cluster[0];
  const profile = buildClusterProfile(cluster);
  const itemProfile = buildClusterProfile([item]);

  /*
   * Adversaire différent = sujet différent.
   * Exemple : Bratislava ne doit jamais rejoindre un cluster
   * dont l'identité est Lille/LOSC.
   */
  if (
    itemProfile.opponents.length > 0 &&
    profile.opponents.length > 0
  ) {
    const sharedOpponent = itemProfile.opponents.some((opponent) =>
      profile.opponents.includes(opponent)
    );

    if (!sharedOpponent) {
      return 0;
    }
  }

  /*
   * Si l'un des titres possède un thème éditorial précis et que
   * l'autre possède un thème précis différent, on sépare.
   */
  const itemTopic = itemProfile.topic;
  const clusterTopic = profile.topic;

  if (
    itemTopic !== 'general' &&
    clusterTopic !== 'general' &&
    itemTopic !== clusterTopic
  ) {
    return 0;
  }

  const titleScore = titleSimilarity(
    item.title,
    reference.title
  );

  const tokenScore = tokenSimilarityAgainstCluster(
    item.title,
    cluster
  );

  const entityScore = entitySimilarity(
    item.title,
    reference.title
  );

  const opponentScore =
    sharedSetScore(
      itemProfile.opponents,
      profile.opponents
    );

  const competitionScore =
    sharedSetScore(
      itemProfile.competitions,
      profile.competitions
    );

  let score = Math.max(
    titleScore * 0.55,
    tokenScore * 0.55,
    entityScore * 0.55
  );

  if (opponentScore > 0) {
    score += 0.25;
  }

  if (competitionScore > 0) {
    score += 0.08;
  }

  /*
   * Pour les sujets sans adversaire, on demande une ressemblance
   * textuelle beaucoup plus forte. Cela évite notamment de fusionner
   * un article sur un maillot avec un article sur une pelouse.
   */
  if (
    itemProfile.opponents.length === 0 &&
    profile.opponents.length === 0 &&
    itemTopic === 'general'
  ) {
    score = Math.max(
      titleScore * 0.7,
      tokenScore * 0.7,
      entityScore * 0.7
    );
  }

  return Math.min(score, 1);
}

function tokenSimilarityAgainstCluster(
  title: string,
  cluster: FeedItem[]
): number {
  let best = 0;

  for (const other of cluster) {
    best = Math.max(
      best,
      titleSimilarity(title, other.title)
    );
  }

  return best;
}

function sharedSetScore(
  a: string[],
  b: string[]
): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const common = a.filter((value) =>
    b.includes(value)
  ).length;

  return common /
    Math.max(a.length, b.length);
}

/* =========================================================
   TITLE SIMILARITY
========================================================= */

function titleSimilarity(
  a: string,
  b: string
): number {
  const tokensA = meaningfulTokens(a);
  const tokensB = meaningfulTokens(b);

  if (
    tokensA.length === 0 ||
    tokensB.length === 0
  ) {
    return 0;
  }

  const intersection = tokensA.filter((token) =>
    tokensB.includes(token)
  ).length;

  const union = new Set([
    ...tokensA,
    ...tokensB,
  ]).size;

  if (union === 0) {
    return 0;
  }

  const jaccard = intersection / union;
  const containment =
    intersection /
    Math.min(tokensA.length, tokensB.length);

  return Math.max(
    jaccard,
    containment * 0.72
  );
}

/* =========================================================
   TOPIC FAMILY
========================================================= */

function getTopicFamily(title: string): string {
  const text = normalizeText(title);

  const topicRules: Array<{
    name: string;
    keywords: string[];
  }> = [
    {
      name: 'kit',
      keywords: [
        'maillot',
        'maillots',
        'tenue',
        'tenues',
        'equipementier',
        'equipement',
      ],
    },
    {
      name: 'pitch',
      keywords: [
        'pelouse',
        'terrain',
        'gazon',
        'parc des princes',
      ],
    },
    {
      name: 'transfer',
      keywords: [
        'mercato',
        'transfert',
        'transferts',
        'recrutement',
        'recrue',
        'arrivee',
        'arrive',
        'depart',
        'quitter',
      ],
    },
    {
      name: 'contract',
      keywords: [
        'contrat',
        'prolongation',
        'prolonge',
        'sous contrat',
      ],
    },
    {
      name: 'injury',
      keywords: [
        'blessure',
        'blesse',
        'blesse',
        'forfait',
        'indisponible',
        'retour',
      ],
    },
    {
      name: 'match',
      keywords: [
        'match',
        'rencontre',
        'contre',
        'face a',
        'affronte',
        'affronter',
        'opposera',
        'opposer',
        'score',
        'resultat',
        'notes',
        'note',
        'composition',
        'compositions',
        'groupe',
        'equipe',
        'titulaire',
        'titulaires',
        'absent',
        'absents',
        'diffusion',
        'streaming',
        'chaine',
        'heure',
        'programme',
      ],
    },
    {
      name: 'player',
      keywords: [
        'ballon d or',
        'kopa',
        'prix',
        'trophee',
        'distinction',
        'candidat',
        'candidates',
        'candidats',
        'nomme',
        'nommes',
      ],
    },
    {
      name: 'coach',
      keywords: [
        'entraineur',
        'coach',
        'luis enrique',
      ],
    },
  ];

  for (const rule of topicRules) {
    if (
      rule.keywords.some((keyword) =>
        text.includes(normalizeText(keyword))
      )
    ) {
      return rule.name;
    }
  }

  return 'general';
}

/* =========================================================
   COMPETITIONS
========================================================= */

function extractCompetitions(
  title: string
): string[] {
  const text = normalizeText(title);
  const competitions = new Set<string>();

  const knownCompetitions = [
    'ligue des champions',
    'champions league',
    'youth league',
    'ligue 1',
    'ligue 2',
    'coupe de france',
    'trophee des champions',
  ];

  for (const competition of knownCompetitions) {
    if (
      text.includes(
        normalizeText(competition)
      )
    ) {
      competitions.add(
        normalizeText(competition)
      );
    }
  }

  return Array.from(competitions);
}

/* =========================================================
   ENTITY SIMILARITY
========================================================= */

function entitySimilarity(
  a: string,
  b: string
): number {
  const entitiesA = extractEntities(a);
  const entitiesB = extractEntities(b);

  if (
    entitiesA.length === 0 ||
    entitiesB.length === 0
  ) {
    return 0;
  }

  const common = entitiesA.filter((entity) =>
    entitiesB.includes(entity)
  );

  if (common.length === 0) {
    return 0;
  }

  return Math.min(
    0.85,
    0.35 + common.length * 0.18
  );
}

/* =========================================================
   OPPONENT EXTRACTION
========================================================= */

function extractAllOpponents(
  title: string
): string[] {
  const text = normalizeText(title);
  const opponents = new Set<string>();

  const knownOpponents = [
    'bratislava',
    'slovan bratislava',
    'auxerre',
    'marseille',
    'om',
    'strasbourg',
    'lyon',
    'lens',
    'lille',
    'monaco',
    'rennes',
    'nice',
    'nantes',
    'montpellier',
    'toulouse',
    'reims',
    'brest',
    'lorient',
    'saint etienne',
    'saint-etienne',
    'le havre',
    'angers',
    'nimes',
    'metz',
    'manchester city',
    'manchester united',
    'arsenal',
    'liverpool',
    'chelsea',
    'tottenham',
    'real madrid',
    'barcelone',
    'barcelona',
    'atletico madrid',
    'bayern',
    'inter milan',
    'inter',
    'juventus',
    'milan',
    'atalanta',
    'dortmund',
    'borussia dortmund',
  ];

  for (const opponent of knownOpponents) {
    if (
      text.includes(
        normalizeText(opponent)
      )
    ) {
      if (
        opponent === 'slovan bratislava' ||
        opponent === 'bratislava'
      ) {
        opponents.add('slovan bratislava');
      } else if (opponent === 'om') {
        opponents.add('marseille');
      } else if (opponent === 'inter') {
        opponents.add('inter milan');
      } else if (opponent === 'milan') {
        opponents.add('milan');
      } else {
        opponents.add(
          normalizeText(opponent)
        );
      }
    }
  }

  return Array.from(opponents);
}

/* =========================================================
   ENTITIES
========================================================= */

function extractEntities(
  title: string
): string[] {
  const text = normalizeText(title);

  const entities = [
    'psg',
    'paris saint germain',
    'donnarumma',
    'hakimi',
    'marquinhos',
    'vitinha',
    'joao neves',
    'dembele',
    'barcola',
    'kvaratskhelia',
    'doue',
    'luis enrique',
    'mbappe',
    'bratislava',
    'slovan bratislava',
    'ligue des champions',
    'champions league',
    'youth league',
    'ligue 1',
    'coupe de france',
  ];

  return entities
    .filter((entity) =>
      text.includes(
        normalizeText(entity)
      )
    )
    .map((entity) =>
      normalizeText(entity)
    );
}


/* =========================================================
   PROCESS CLUSTER
========================================================= */

async function processCluster(
  cluster: FeedItem[],
  recentArticles: Array<{
    title: string;
    slug: string;
    sourceUrl: string | null;
  }>,
  clusterNumber: number
): Promise<ProcessClusterResult> {
  const sortedSources =
    [...cluster]
      .sort(
        (a, b) =>
          getSourcePriority(
            b.source
          ) -
          getSourcePriority(
            a.source
          )
      )
      .slice(
        0,
        MAX_SOURCES_PER_ARTICLE
      );

  const enrichment =
    await enrichSources(
      sortedSources
    );

  const enrichedSources =
    enrichment.sources;

  const geminiErrors: string[] =
    [];

  let geminiCalls = 0;
  let geminiSuccess = 0;

  let invalidJson = 0;
  let tooShort = 0;
  let tooShortAfterRetry = 0;
  let slugErrors = 0;
  let createErrors = 0;

  /* -----------------------------------------------------
     PREMIÈRE GÉNÉRATION
  ----------------------------------------------------- */

  const first =
    await callGemini(
      enrichedSources
    );

  geminiCalls++;

  if (
    first.error
  ) {
    geminiErrors.push(
      first.error
    );
  }

  /*
   * Si Gemini indique que le quota est atteint,
   * on arrête immédiatement ce cluster.
   */
  if (
    first.quotaExceeded
  ) {
    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "gemini_quota_exceeded",

        detail:
          first.error ||
          "Gemini quota exceeded",
      },
    };
  }

  let article =
    first.article;

  /* -----------------------------------------------------
     GENERATION INVALIDE
  ----------------------------------------------------- */

  if (!article) {
    invalidJson++;

    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "gemini_error",

        detail:
          first.error ||
          "Gemini returned no article",
      },
    };
  }

  /* -----------------------------------------------------
     CONTRÔLE LONGUEUR
  ----------------------------------------------------- */

  let wordCount =
    countWords(
      article.content
    );

  if (
    wordCount <
    MIN_ARTICLE_WORDS
  ) {
    tooShort++;

    const retry =
      await callGemini(
        enrichedSources,
        true
      );

    geminiCalls++;

    if (
      retry.error
    ) {
      geminiErrors.push(
        retry.error
      );
    }

    /*
     * Nouveau quota atteint pendant le retry.
     */
    if (
      retry.quotaExceeded
    ) {
      return {
        created: false,

        geminiCalls,
        geminiSuccess,
        geminiErrors,

        invalidJson,
        tooShort,
        tooShortAfterRetry,
        slugErrors,
        createErrors,

        enrichment,

        diagnostic: {
          cluster:
            clusterNumber,

          sources:
            sortedSources.map(
              (x) =>
                x.source
            ),

          titles:
            sortedSources.map(
              (x) =>
                x.title
            ),

          outcome:
            "gemini_quota_exceeded",

          detail:
            retry.error ||
            "Gemini quota exceeded",
        },
      };
    }

    if (
      retry.article
    ) {
      article =
        retry.article;

      wordCount =
        countWords(
          article.content
        );
    }
  }

  /* -----------------------------------------------------
     ARTICLE TOUJOURS TROP COURT
  ----------------------------------------------------- */

  if (
    wordCount <
    MIN_ARTICLE_WORDS
  ) {
    tooShortAfterRetry++;

    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "article_too_short",

        detail:
          `${wordCount} words after retry`,
      },
    };
  }

  geminiSuccess++;

  /* -----------------------------------------------------
     DOUBLON DATABASE
  ----------------------------------------------------- */

  const duplicate =
    await prisma.article.findFirst(
      {
        where: {
          OR: [
            {
              title: {
                equals:
                  article.title,

                mode:
                  "insensitive",
              },
            },

            {
              sourceUrl:
                sortedSources[0]
                  ?.link ||
                "",
            },
          ],
        },

        select: {
          id: true,
        },
      }
    );

  if (duplicate) {
    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "duplicate",

        detail:
          "Article already exists",
      },
    };
  }

  /* -----------------------------------------------------
     SLUG
  ----------------------------------------------------- */

  let slug =
    slugify(
      article.title
    );

  if (!slug) {
    slugErrors++;

    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "slug_error",

        detail:
          "Unable to generate slug",
      },
    };
  }

  slug =
    await makeUniqueSlug(
      slug
    );

  /* -----------------------------------------------------
     CREATE DATABASE
  ----------------------------------------------------- */

  try {
    await prisma.article.create({
      data: {
        title:
          article.title,

        slug,

        excerpt:
          article.excerpt,

        content:
          article.content,

        club:
          "PSG",

        status:
          "DRAFT",

        isAiGenerated:
          true,

        sourceUrl:
          sortedSources[0]
            ?.link ||
          null,
      },
    });
  } catch (error) {
    createErrors++;

    return {
      created: false,

      geminiCalls,
      geminiSuccess,
      geminiErrors,

      invalidJson,
      tooShort,
      tooShortAfterRetry,
      slugErrors,
      createErrors,

      enrichment,

      diagnostic: {
        cluster:
          clusterNumber,

        sources:
          sortedSources.map(
            (x) =>
              x.source
          ),

        titles:
          sortedSources.map(
            (x) =>
              x.title
          ),

        outcome:
          "create_error",

        detail:
          error instanceof Error
            ? error.message
            : "Database error",
      },
    };
  }

  /* -----------------------------------------------------
     SUCCÈS
  ----------------------------------------------------- */

  return {
    created: true,

    articleTitle:
      article.title,

    sourceUrl:
      sortedSources[0]
        ?.link ||
      null,

    geminiCalls,
    geminiSuccess,
    geminiErrors,

    invalidJson,
    tooShort,
    tooShortAfterRetry,
    slugErrors,
    createErrors,

    enrichment,

    diagnostic: {
      cluster:
        clusterNumber,

      sources:
        sortedSources.map(
          (x) =>
            x.source
        ),

      titles:
        sortedSources.map(
          (x) =>
            x.title
        ),

      outcome:
        "created",

      detail:
        `${wordCount} words`,
    },
  };
}

/* =========================================================
   SOURCE ENRICHMENT
========================================================= */

async function enrichSources(
  sources: ArticleInput[]
): Promise<EnrichmentResult> {
  const results =
    await Promise.all(
      sources.map(
        async (source) => {
          if (
            !shouldFetchSourcePage(
              source,
              sources
            )
          ) {
            return {
              source,
              content: "",
              fetched: false,
              error: null,
            };
          }

          try {
            const controller =
              new AbortController();

            const timeout =
              setTimeout(
                () =>
                  controller.abort(),
                SOURCE_TIMEOUT_MS
              );

            const response =
              await fetch(
                source.link,
                {
                  signal:
                    controller.signal,

                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 PSG-Direct/1.0",
                  },

                  cache:
                    "no-store",
                }
              );

            clearTimeout(
              timeout
            );

            if (
              !response.ok
            ) {
              return {
                source,
                content: "",
                fetched: false,

                error:
                  `${source.source}: HTTP ${response.status}`,
              };
            }

            const html =
              await response.text();

            const text =
              cleanPageText(
                html
              ).slice(
                0,
                MAX_SOURCE_PAGE_CHARS
              );

            return {
              source,

              content:
                text,

              fetched:
                text.length > 0,

              error:
                text.length > 0
                  ? null
                  : `${source.source}: empty page`,
            };
          } catch (error) {
            return {
              source,

              content: "",

              fetched:
                false,

              error:
                `${source.source}: ${
                  error instanceof Error
                    ? error.message
                    : "page fetch error"
                }`,
            };
          }
        }
      )
    );

  const enrichedSources =
    results.map(
      (result) => ({
        ...result.source,

        description:
          result.content
            ? `${result.source.description}\n\nSOURCE PAGE:\n${result.content}`
            : result.source.description,
      })
    );

  return {
    sources:
      enrichedSources,

    pagesFetched:
      results.filter(
        (x) =>
          x.fetched
      ).length,

    pagesFailed:
      results.filter(
        (x) =>
          x.error
      ).length,

    enrichedCharacters:
      results.reduce(
        (sum, x) =>
          sum +
          x.content.length,
        0
      ),

    pageErrors:
      results
        .filter(
          (x) =>
            x.error
        )
        .map(
          (x) =>
            x.error as string
        ),
  };
}

function shouldFetchSourcePage(
  source: ArticleInput,
  cluster: ArticleInput[]
): boolean {
  const description =
    source.description ||
    "";

  if (
    description.length <
    LOW_INFORMATION_WORDS
  ) {
    return true;
  }

  if (
    cluster.length > 1
  ) {
    return true;
  }

  if (
    getSourcePriority(
      source.source
    ) >= 4
  ) {
    return true;
  }

  if (
    description.length <
    500
  ) {
    return true;
  }

  const concreteIntent =
    /composition|compositions|groupe|équipe|equipe|blessure|blessé|blessés|transfert|mercato|contrat|prolongation|conférence|conference|match|rencontre|score|résultat|resultat|départ|depart|arrivée|arrivee|titulaire|absent|retour/i;

  if (
    concreteIntent.test(
      source.title
    )
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   GEMINI
========================================================= */

async function callGemini(
  sources: ArticleInput[],
  retry = false
): Promise<GeminiCallResult> {
  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ];

  const sourceText =
    sources
      .map(
        (source, index) =>
          `
SOURCE ${index + 1}
Nom : ${source.source}
Titre : ${source.title}
URL : ${source.link}
Informations :
${source.description}
`
      )
      .join(
        "\n\n"
      );

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Ta mission est de rédiger un article de presse sportive ORIGINAL en français à partir EXCLUSIVEMENT des informations fournies par les sources ci-dessous.

RÈGLES ABSOLUES :

- Ne jamais inventer une information.
- Ne jamais inventer de citation.
- Ne jamais inventer de chiffre.
- Ne jamais inventer de blessure.
- Ne jamais inventer de transfert.
- Ne jamais inventer de composition.
- Ne jamais ajouter une information extérieure aux sources.
- Ne jamais mentionner l'intelligence artificielle.
- Ne jamais mentionner que tu as utilisé des sources.
- Ne pas recopier les phrases des sources.
- Reformuler entièrement.
- Écrire dans un style naturel de journaliste sportif français.
- Le texte doit être clair, dynamique et agréable à lire.
- Utiliser Markdown.
- Le titre doit être informatif et naturel.
- Le chapô doit résumer l'information principale.
- Le contenu doit contenir au minimum ${MIN_ARTICLE_WORDS} mots.
- Viser environ ${TARGET_ARTICLE_WORDS} mots.
- Ne jamais dépasser environ ${MAX_ARTICLE_WORDS} mots.
- Si plusieurs sources parlent du même événement, fusionner les informations pertinentes.
- Si certaines sources se contredisent, ne pas inventer pour résoudre la contradiction.
- Ne conserver que les informations suffisamment établies dans les sources.

${
  retry
    ? `
ATTENTION :
La précédente génération était trop courte.
Cette fois, produis impérativement un article complet d'au moins ${MIN_ARTICLE_WORDS} mots.
Développe davantage le contexte disponible dans les sources sans rien inventer.
`
    : ""
}

SOURCES :

${sourceText}

Réponds UNIQUEMENT avec un JSON valide sous cette forme :

{
  "title": "Titre de l'article",
  "excerpt": "Chapô de l'article",
  "content": "Contenu complet en Markdown"
}
`;

  for (
    const model of models
  ) {
    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          GEMINI_TIMEOUT_MS
        );

      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method:
              "POST",

            signal:
              controller.signal,

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text:
                          prompt,
                      },
                    ],
                  },
                ],

                generationConfig: {
                  temperature:
                    0.2,

                  maxOutputTokens:
                    4500,

                  responseMimeType:
                    "application/json",
                },
              }),
          }
        );

      clearTimeout(
        timeout
      );

      const raw =
        await response.text();

      if (
        !response.ok
      ) {
        const lower =
          raw.toLowerCase();

        const quotaExceeded =
          response.status ===
            429 ||
          lower.includes(
            "quota exceeded"
          ) ||
          lower.includes(
            "generate_content_free_tier_requests"
          ) ||
          lower.includes(
            "rate limit"
          ) ||
          lower.includes(
            "resource exhausted"
          );

        if (
          quotaExceeded
        ) {
          return {
            article:
              null,

            error:
              `Gemini ${model}: HTTP ${response.status} quota/rate limit exceeded`,

            quotaExceeded:
              true,
          };
        }

        continue;
      }

      let data: any;

      try {
        data =
          JSON.parse(
            raw
          );
      } catch {
        return {
          article:
            null,

          error:
            `Gemini ${model}: invalid API JSON`,

          quotaExceeded:
            false,
        };
      }

      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;

      if (
        typeof text !==
        "string"
      ) {
        continue;
      }

      const parsed =
        parseGeminiJson(
          text
        );

      if (!parsed) {
        return {
          article:
            null,

          error:
            `Gemini ${model}: invalid generated JSON`,

          quotaExceeded:
            false,
        };
      }

      return {
        article:
          parsed,

        error:
          null,

        quotaExceeded:
          false,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Gemini request error";

      if (
        message.includes(
          "aborted"
        )
      ) {
        continue;
      }

      continue;
    }
  }

  return {
    article:
      null,

    error:
      "Gemini: all configured models failed",

    quotaExceeded:
      false,
  };
}

/* =========================================================
   GEMINI JSON
========================================================= */

function parseGeminiJson(
  text: string
): GeminiArticle | null {
  let cleaned =
    text.trim();

  cleaned =
    cleaned.replace(
      /^```json\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /^```\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /\s*```$/i,
      ""
    );

  try {
    const parsed =
      JSON.parse(
        cleaned
      );

    if (
      !parsed ||
      typeof parsed.title !==
        "string" ||
      typeof parsed.excerpt !==
        "string" ||
      typeof parsed.content !==
        "string"
    ) {
      return null;
    }

    return {
      title:
        cleanGeneratedText(
          parsed.title
        ),

      excerpt:
        cleanGeneratedText(
          parsed.excerpt
        ),

      content:
        cleanGeneratedText(
          parsed.content
        ),
    };
  } catch {
    const firstBrace =
      cleaned.indexOf(
        "{"
      );

    const lastBrace =
      cleaned.lastIndexOf(
        "}"
      );

    if (
      firstBrace >= 0 &&
      lastBrace >
        firstBrace
    ) {
      try {
        const parsed =
          JSON.parse(
            cleaned.slice(
              firstBrace,
              lastBrace + 1
            )
          );

        if (
          typeof parsed.title ===
            "string" &&
          typeof parsed.excerpt ===
            "string" &&
          typeof parsed.content ===
            "string"
        ) {
          return {
            title:
              cleanGeneratedText(
                parsed.title
              ),

            excerpt:
              cleanGeneratedText(
                parsed.excerpt
              ),

            content:
              cleanGeneratedText(
                parsed.content
              ),
          };
        }
      } catch {
        return null;
      }
    }

    return null;
  }
}

/* =========================================================
   SLUG
========================================================= */

async function makeUniqueSlug(
  baseSlug: string
): Promise<string> {
  let slug =
    baseSlug;

  let counter = 2;

  while (
    await prisma.article.findUnique(
      {
        where: {
          slug,
        },

        select: {
          id: true,
        },
      }
    )
  ) {
    slug =
      `${baseSlug}-${counter}`;

    counter++;
  }

  return slug;
}

function slugify(
  value: string
): string {
  return normalizeText(
    value
  )
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(
      0,
      180
    );
}

/* =========================================================
   PRIORITIES
========================================================= */

function getSourcePriority(
  source: string
): number {
  switch (
    normalizeText(
      source
    )
  ) {
    case "culturepsg":
      return 5;

    case "rmc sport":
      return 4;

    case "foot mercato":
      return 3;

    case "google news":
      return 2;

    default:
      return 1;
  }
}

function getClusterPriority(
  cluster: FeedItem[]
): number {
  const sourcePriority =
    Math.max(
      ...cluster.map(
        (item) =>
          getSourcePriority(
            item.source
          )
      )
    );

  const sourceCount =
    Math.min(
      cluster.length,
      3
    );

  const recentBonus =
    cluster.some(
      (item) =>
        Date.now() -
          getTimestamp(
            item.pubDate
          ) <
        6 *
          60 *
          60 *
          1000
    )
      ? 2
      : 0;

  return (
    sourcePriority *
      10 +
    sourceCount *
      2 +
    recentBonus
  );
}

/* =========================================================
   TEXT HELPERS
========================================================= */

function normalizeText(
  value: string
): string {
  return value
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /['’]/g,
      " "
    )
    .replace(
      /[^a-z0-9\s-]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function normalizeTitle(
  value: string
): string {
  return normalizeText(
    value
  )
    .replace(
      /\b(le|la|les|un|une|des|du|de|pour|avec|et|a|au|aux|sur|dans|ce|cette|ces)\b/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function normalizeUrl(
  value: string
): string {
  try {
    const url =
      new URL(
        value
      );

    url.hash = "";

    url.search = "";

    return url
      .toString()
      .replace(
        /\/$/,
        ""
      );
  } catch {
    return value
      .trim()
      .replace(
        /\/$/,
        ""
      );
  }
}

function meaningfulTokens(
  value: string
): string[] {
  const stopWords =
    new Set([
      "le",
      "la",
      "les",
      "un",
      "une",
      "des",
      "de",
      "du",
      "d",
      "a",
      "au",
      "aux",
      "en",
      "et",
      "ou",
      "pour",
      "avec",
      "sans",
      "sur",
      "dans",
      "par",
      "chez",
      "ce",
      "cette",
      "ces",
      "son",
      "sa",
      "ses",
      "leur",
      "leurs",
      "qui",
      "que",
      "qu",
      "est",
      "sont",
      "se",
      "fait",
      "plus",
      "apres",
      "avant",
    ]);

  return Array.from(
    new Set(
      normalizeText(
        value
      )
        .split(
          " "
        )
        .filter(
          (token) =>
            token.length >=
              3 &&
            !stopWords.has(
              token
            )
        )
    )
  );
}

function countWords(
  text: string
): number {
  return text
    .replace(
      /[#*_>`[\]()]/g,
      " "
    )
    .split(
      /\s+/
    )
    .filter(
      Boolean
    ).length;
}

/* =========================================================
   HTML CLEANING
========================================================= */

function cleanHtml(
  value: string
): string {
  return decodeHtmlEntities(
    value
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );
}

function cleanPageText(
  html: string
): string {
  return decodeHtmlEntities(
    html
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<noscript[\s\S]*?<\/noscript>/gi,
        " "
      )
      .replace(
        /<svg[\s\S]*?<\/svg>/gi,
        " "
      )
      .replace(
        /<[^>]+>/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim()
  );
}

function cleanGeneratedText(
  value: string
): string {
  return decodeHtmlEntities(
    value
      .replace(
        /\r\n/g,
        "\n"
      )
      .replace(
        /\n{3,}/g,
        "\n\n"
      )
      .trim()
  );
}

function decodeHtmlEntities(
  value: string
): string {
  return value
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&apos;/gi,
      "'"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(
          Number(code)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(
            code,
            16
          )
        )
    );
}

/* =========================================================
   DATE
========================================================= */

function getTimestamp(
  value: string
): number {
  const timestamp =
    Date.parse(
      value || ""
    );

  if (
    Number.isNaN(
      timestamp
    )
  ) {
    return 0;
  }

  return timestamp;
}
