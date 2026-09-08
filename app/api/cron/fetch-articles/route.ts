import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const RSS_FEEDS = [
  {
    name: "Google News",
    url: "https://news.google.com/rss/search?q=PSG+Paris+Saint-Germain+football&hl=fr&gl=FR&ceid=FR:fr",
    priority: 4,
  },
  {
    name: "RMC Sport",
    url: "https://rmcsport.bfmtv.com/rss/football/",
    priority: 1,
  },
  {
    name: "Foot Mercato",
    url: "https://www.footmercato.net/rss",
    priority: 2,
  },
  {
    name: "CulturePSG",
    url: "https://www.culturepsg.com/news?rss",
    priority: 1,
  },
];

const MAX_NEW_ARTICLES = 1;
const MAX_ITEMS_PER_SOURCE = 30;
const MAX_CLUSTERS_TO_PROCESS = 1;

const RSS_TIMEOUT_MS = 4000;
const SOURCE_PAGE_TIMEOUT_MS = 2000;
const MAX_SOURCE_PAGES = 3;
const MAX_SOURCE_TEXT_LENGTH = 6000;

const MIN_ARTICLE_WORDS = 400;
const MAX_ARTICLE_WORDS = 900;

type FeedItem = {
  title: string;
  description: string;
  link: string;
  publishedAt: Date;
  source: string;
  priority: number;
};

type EnrichedSource = {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  description: string;
  pageText: string;
};

type GeminiResponse = {
  title?: unknown;
  excerpt?: unknown;
  content?: unknown;
};

type GenerationSuccess = {
  ok: true;
  result: {
    title: string;
    excerpt: string;
    content: string;
  };
};

type GenerationFailure = {
  ok: false;
  error: string;
};

type GenerationResult =
  | GenerationSuccess
  | GenerationFailure;

type Diagnostic = {
  cluster: number;
  sources: string[];
  titles: string[];
  outcome: string;
  detail?: string;
};

type StorySignals = {
  eventType: string;
  people: string[];
  opponents: string[];
  competitions: string[];
  specificTokens: string[];
};

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get("secret");

    if (!CRON_SECRET || secret !== CRON_SECRET) {
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
          error: "GEMINI_API_KEY manquante",
        },
        {
          status: 500,
        }
      );
    }

    const rssResults = await Promise.allSettled(
      RSS_FEEDS.map((feed) => fetchRSS(feed))
    );

    const allItems: FeedItem[] = [];
    const sourcesOk: string[] = [];
    const rssErrors: string[] = [];

    for (const result of rssResults) {
      if (result.status === "fulfilled") {
        const { feedName, items } = result.value;

        if (items.length > 0) {
          sourcesOk.push(feedName);
          allItems.push(...items);
        }
      } else {
        rssErrors.push(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        );
      }
    }

    const filteredItems = allItems
      .filter(isRelevantPSGItem)
      .sort(
        (a, b) =>
          b.publishedAt.getTime() -
          a.publishedAt.getTime()
      );

    const uniqueItems = dedupeFeedItems(
      filteredItems
    );

    const clusters = buildClusters(
      uniqueItems
    );

    const recentArticles =
      await prisma.article.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: 100,
        select: {
          title: true,
          sourceUrl: true,
          createdAt: true,
        },
      });

    const candidateClusters =
      clusters.filter((cluster) => {
        const hasExistingSource =
          cluster.some((item) =>
            recentArticles.some(
              (article) =>
                article.sourceUrl &&
                normalizeUrl(
                  article.sourceUrl
                ) ===
                  normalizeUrl(
                    item.link
                  )
            )
          );

        if (hasExistingSource) {
          return false;
        }

        const hasSimilarExistingArticle =
          cluster.some((item) =>
            recentArticles.some(
              (article) =>
                titleSimilarity(
                  item.title,
                  article.title
                ) >= 0.88
            )
          );

        return !hasSimilarExistingArticle;
      });

    const clustersToProcess =
      candidateClusters
        .sort((a, b) => {
          const scoreA =
            clusterPriorityScore(a);

          const scoreB =
            clusterPriorityScore(b);

          if (scoreA !== scoreB) {
            return scoreB - scoreA;
          }

          return (
            b[0].publishedAt.getTime() -
            a[0].publishedAt.getTime()
          );
        })
        .slice(
          0,
          MAX_CLUSTERS_TO_PROCESS
        );

    const diagnostics: Diagnostic[] = [];

    let created = 0;
    let skipped = 0;
    let duplicates = 0;

    let sourcePagesFetched = 0;
    let sourcePagesFailed = 0;
    let enrichedCharacters = 0;

    const sourcePageErrors: string[] = [];

    for (
      let index = 0;
      index < clustersToProcess.length;
      index++
    ) {
      if (
        created >=
        MAX_NEW_ARTICLES
      ) {
        break;
      }

      const cluster =
        clustersToProcess[index];

      const diagnostic: Diagnostic = {
        cluster: index + 1,
        sources: [
          ...new Set(
            cluster.map(
              (item) => item.source
            )
          ),
        ],
        titles: cluster
          .slice(0, 5)
          .map(
            (item) => item.title
          ),
        outcome: "processing",
      };

      try {
        const enrichment =
          await enrichCluster(
            cluster
          );

        sourcePagesFetched +=
          enrichment.pagesFetched;

        sourcePagesFailed +=
          enrichment.pagesFailed;

        enrichedCharacters +=
          enrichment.characters;

        sourcePageErrors.push(
          ...enrichment.errors
        );

        const generation =
          await generateArticle(
            cluster,
            enrichment.sources
          );

        if (
          "error" in generation
        ) {
          diagnostic.outcome =
            "generation_error";

          diagnostic.detail =
            generation.error;

          diagnostics.push(
            diagnostic
          );

          skipped++;
          continue;
        }

        let article =
          generation.result;

        let words =
          countWords(
            article.content
          );

        if (
          words <
          MIN_ARTICLE_WORDS
        ) {
          const expanded =
            await expandArticle(
              article,
              cluster,
              enrichment.sources
            );

          if (
            "result" in expanded
          ) {
            article =
              expanded.result;

            words =
              countWords(
                article.content
              );
          }
        }

        if (
          words <
          MIN_ARTICLE_WORDS
        ) {
          diagnostic.outcome =
            "too_short";

          diagnostic.detail =
            `title=${article.title.length}, words=${words}, excerpt=${article.excerpt.length}`;

          diagnostics.push(
            diagnostic
          );

          skipped++;
          continue;
        }

        if (
          words >
          MAX_ARTICLE_WORDS
        ) {
          article.content =
            trimArticleToWordLimit(
              article.content,
              MAX_ARTICLE_WORDS
            );
        }

        article.content =
          normalizeArticleStructure(
            article.content
          );

        article.excerpt =
          normalizeText(
            article.excerpt
          );

        const slugBase =
          slugify(
            article.title
          );

        const slug =
          await makeUniqueSlug(
            slugBase
          );

        if (!slug) {
          diagnostic.outcome =
            "slug_error";

          diagnostic.detail =
            "Impossible de générer le slug.";

          diagnostics.push(
            diagnostic
          );

          skipped++;
          continue;
        }

        const primarySource =
          [...cluster].sort(
            (a, b) =>
              b.priority -
                a.priority ||
              b.publishedAt.getTime() -
                a.publishedAt.getTime()
          )[0];

        const existingBySource =
          await prisma.article.findFirst({
            where: {
              sourceUrl:
                primarySource.link,
            },
            select: {
              id: true,
            },
          });

        if (existingBySource) {
          diagnostic.outcome =
            "duplicate_source";

          diagnostics.push(
            diagnostic
          );

          duplicates++;
          continue;
        }

        await prisma.article.create({
          data: {
            title:
              article.title,

            slug,

            content:
              article.content,

            excerpt:
              article.excerpt,

            club: "PSG",

            status: "DRAFT",

            isAiGenerated: true,

            sourceUrl:
              primarySource.link,
          },
        });

        created++;

        diagnostic.outcome =
          "created";

        diagnostic.detail =
          `words=${countWords(
            article.content
          )}, sources=${cluster.length}, pages=${enrichment.pagesFetched}, chars=${enrichment.characters}`;

        diagnostics.push(
          diagnostic
        );
      } catch (error) {
        diagnostic.outcome =
          "error";

        diagnostic.detail =
          error instanceof Error
            ? error.message
            : String(error);

        diagnostics.push(
          diagnostic
        );

        skipped++;
      }
    }

    const elapsedMs =
      Date.now() -
      startedAt;

    return NextResponse.json({
      checked:
        allItems.length,

      newItems:
        uniqueItems.length,

      clusters:
        clusters.length,

      candidateClusters:
        candidateClusters.length,

      processedClusters:
        clustersToProcess.length,

      deferred:
        Math.max(
          0,
          candidateClusters.length -
            clustersToProcess.length
        ),

      created,

      skipped,

      duplicates,

      sourcesOk,

      sources:
        RSS_FEEDS.map(
          (feed) =>
            feed.name
        ),

      fusion: true,

      optimized: true,

      enrichment: true,

      diagnostics: {
        geminiCalls:
          diagnostics.filter(
            (item) =>
              item.outcome ===
                "created" ||
              item.outcome ===
                "too_short" ||
              item.outcome ===
                "generation_error"
          ).length,

        geminiSuccess:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "created"
          ).length,

        geminiErrors:
          diagnostics
            .filter(
              (item) =>
                item.outcome ===
                "generation_error"
            )
            .map(
              (item) =>
                item.detail ||
                "Erreur Gemini"
            ),

        invalidJson: 0,

        tooShort:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "too_short"
          ).length,

        slugErrors:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "slug_error"
          ).length,

        createErrors:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "error"
          ).length,

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
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 500,
      }
    );
  }
}

async function fetchRSS(feed: {
  name: string;
  url: string;
  priority: number;
}): Promise<{
  feedName: string;
  items: FeedItem[];
}> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      RSS_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        feed.url,
        {
          headers: {
            Accept:
              "application/rss+xml, application/xml, text/xml, */*",

            "User-Agent":
              "PSGDirectBot/1.0 (+https://psg-direct-app-1ktj.vercel.app)",
          },

          cache:
            "no-store",

          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const xml =
      await response.text();

    const parsed =
      parseRSS(xml);

    const items =
      parsed
        .slice(
          0,
          MAX_ITEMS_PER_SOURCE
        )
        .map(
          (item) => ({
            ...item,
            source:
              feed.name,
            priority:
              feed.priority,
          })
        );

    return {
      feedName:
        feed.name,
      items,
    };
  } finally {
    clearTimeout(
      timeout
    );
  }
}

function parseRSS(
  xml: string
): Array<{
  title: string;
  description: string;
  link: string;
  publishedAt: Date;
}> {
  const items: Array<{
    title: string;
    description: string;
    link: string;
    publishedAt: Date;
  }> = [];

  const itemMatches =
    xml.match(
      /<item\b[\s\S]*?<\/item>/gi
    );

  if (!itemMatches) {
    return items;
  }

  for (
    const itemXml of itemMatches
  ) {
    const title =
      extractXMLTag(
        itemXml,
        "title"
      ) || "";

    const description =
      extractXMLTag(
        itemXml,
        "description"
      ) ||
      extractXMLTag(
        itemXml,
        "content:encoded"
      ) ||
      "";

    const link =
      extractXMLTag(
        itemXml,
        "link"
      ) ||
      extractXMLTag(
        itemXml,
        "guid"
      ) ||
      "";

    const pubDate =
      extractXMLTag(
        itemXml,
        "pubDate"
      ) ||
      extractXMLTag(
        itemXml,
        "dc:date"
      ) ||
      extractXMLTag(
        itemXml,
        "published"
      ) ||
      "";

    if (
      !title ||
      !link
    ) {
      continue;
    }

    const parsedDate =
      new Date(
        pubDate
      );

    items.push({
      title:
        decodeHtmlEntities(
          stripHtml(
            title
          )
        ).trim(),

      description:
        decodeHtmlEntities(
          stripHtml(
            description
          )
        ).trim(),

      link:
        link.trim(),

      publishedAt:
        Number.isNaN(
          parsedDate.getTime()
        )
          ? new Date()
          : parsedDate,
    });
  }

  return items;
}

function extractXMLTag(
  xml: string,
  tag: string
): string {
  const escapedTag =
    tag.replace(
      /[-/\\^$*+?.()|[\]{}]/g,
      "\\$&"
    );

  const regex =
    new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
      "i"
    );

  const match =
    xml.match(
      regex
    );

  return (
    match?.[1] || ""
  );
}

function isRelevantPSGItem(
  item: FeedItem
): boolean {
  const text =
    normalizeForComparison(
      `${item.title} ${item.description}`
    );

  const positiveSignals = [
    "psg",
    "paris saint germain",
    "paris sg",
    "paris saint-germain",
    "paris saintgermain",
  ];

  return positiveSignals.some(
    (signal) =>
      text.includes(
        signal
      )
  );
}

function dedupeFeedItems(
  items: FeedItem[]
): FeedItem[] {
  const seenUrls =
    new Set<string>();

  const seenTitles =
    new Set<string>();

  const result: FeedItem[] =
    [];

  for (
    const item of items
  ) {
    const normalizedUrl =
      normalizeUrl(
        item.link
      );

    if (
      normalizedUrl &&
      seenUrls.has(
        normalizedUrl
      )
    ) {
      continue;
    }

    const normalizedTitle =
      normalizeTitle(
        item.title
      );

    if (
      normalizedTitle &&
      seenTitles.has(
        normalizedTitle
      )
    ) {
      continue;
    }

    if (
      normalizedUrl
    ) {
      seenUrls.add(
        normalizedUrl
      );
    }

    if (
      normalizedTitle
    ) {
      seenTitles.add(
        normalizedTitle
      );
    }

    result.push(
      item
    );
  }

  return result;
}

/**
 * Regroupement strict.
 *
 * Le simple mot "PSG" ne permet plus
 * de regrouper deux articles.
 */
function buildClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters:
    FeedItem[][] = [];

  for (
    const item of items
  ) {
    let bestCluster:
      FeedItem[] | null =
      null;

    let bestScore =
      0;

    for (
      const cluster of clusters
    ) {
      const score =
        clusterSimilarity(
          item,
          cluster
        );

      if (
        score >
        bestScore
      ) {
        bestScore =
          score;

        bestCluster =
          cluster;
      }
    }

    if (
      bestCluster &&
      bestScore >=
        0.62
    ) {
      bestCluster.push(
        item
      );
    } else {
      clusters.push(
        [item]
      );
    }
  }

  return clusters;
}

function clusterSimilarity(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  let best =
    0;

  for (
    const other of cluster
  ) {
    const score =
      storyCompatibility(
        item,
        other
      );

    if (
      score >
      best
    ) {
      best =
        score;
    }
  }

  return best;
}

function storyCompatibility(
  a: FeedItem,
  b: FeedItem
): number {
  const titleScore =
    titleSimilarity(
      a.title,
      b.title
    );

  const signalsA =
    extractStorySignals(
      a.title
    );

  const signalsB =
    extractStorySignals(
      b.title
    );

  if (
    signalsA.opponents.length >
      0 &&
    signalsB.opponents.length >
      0 &&
    !hasOverlap(
      signalsA.opponents,
      signalsB.opponents
    )
  ) {
    return 0;
  }

  if (
    signalsA.people.length >
      0 &&
    signalsB.people.length >
      0 &&
    !hasOverlap(
      signalsA.people,
      signalsB.people
    ) &&
    titleScore <
      0.84
  ) {
    return 0;
  }

  if (
    signalsA.eventType !==
      "general" &&
    signalsB.eventType !==
      "general" &&
    signalsA.eventType !==
      signalsB.eventType &&
    titleScore <
      0.84
  ) {
    return 0;
  }

  const opponentOverlap =
    hasOverlap(
      signalsA.opponents,
      signalsB.opponents
    );

  const peopleOverlap =
    hasOverlap(
      signalsA.people,
      signalsB.people
    );

  const competitionOverlap =
    hasOverlap(
      signalsA.competitions,
      signalsB.competitions
    );

  const tokenOverlap =
    hasOverlap(
      signalsA.specificTokens,
      signalsB.specificTokens
    );

  const sameEventType =
    signalsA.eventType ===
    signalsB.eventType;

  if (
    opponentOverlap &&
    sameEventType &&
    signalsA.eventType !==
      "general"
  ) {
    return Math.max(
      0.78,
      titleScore *
        0.45 +
        0.55
    );
  }

  if (
    peopleOverlap &&
    sameEventType &&
    signalsA.eventType !==
      "general"
  ) {
    return Math.max(
      0.74,
      titleScore *
        0.5 +
        0.5
    );
  }

  if (
    titleScore >=
    0.84
  ) {
    return titleScore;
  }

  let score =
    titleScore *
    0.42;

  if (
    opponentOverlap
  ) {
    score +=
      0.24;
  }

  if (
    peopleOverlap
  ) {
    score +=
      0.18;
  }

  if (
    competitionOverlap
  ) {
    score +=
      0.04;
  }

  if (
    tokenOverlap
  ) {
    score +=
      0.16;
  }

  if (
    !opponentOverlap &&
    !peopleOverlap &&
    !tokenOverlap &&
    titleScore <
      0.84
  ) {
    return 0;
  }

  return Math.min(
    1,
    score
  );
}

function extractStorySignals(
  title: string
): StorySignals {
  const text =
    normalizeForComparison(
      title
    );

  let eventType =
    "general";

  if (
    containsAny(
      text,
      [
        "composition",
        "compo",
        "onze probable",
        "onze",
        "titulaire",
        "titular",
        "lineup",
        "formation",
        "equipe probable",
      ]
    )
  ) {
    eventType =
      "lineup";
  } else if (
    containsAny(
      text,
      [
        "blessure",
        "blesse",
        "forfait",
        "absent",
        "indisponible",
        "retour",
        "genou",
        "cheville",
        "ischio",
        "medical",
      ]
    )
  ) {
    eventType =
      "injury";
  } else if (
    containsAny(
      text,
      [
        "mercato",
        "transfert",
        "transferts",
        "recrutement",
        "recrute",
        "arrivee",
        "arrive",
        "depart",
        "parti",
        "signe",
        "signature",
        "cible",
        "interesse",
        "interet",
        "offre",
        "negociation",
        "negocie",
        "piste",
      ]
    )
  ) {
    eventType =
      "transfer";
  } else if (
    containsAny(
      text,
      [
        "critique",
        "accuse",
        "accusation",
        "scandalise",
        "scandale",
        "colere",
        "tacle",
        "attaque",
        "reproche",
        "reproches",
        "avis",
        "declaration",
        "declarations",
        "sort du silence",
      ]
    )
  ) {
    eventType =
      "quote";
  } else if (
    containsAny(
      text,
      [
        "match",
        "rencontre",
        "affronte",
        "affronter",
        "contre",
        "victoire",
        "defaite",
        "nul",
        "score",
        "resultat",
      ]
    )
  ) {
    eventType =
      "match";
  } else if (
    containsAny(
      text,
      [
        "ballon d'or",
        "ballon d or",
        "trophee",
        "prix",
        "recompense",
        "nommes",
        "nomines",
      ]
    )
  ) {
    eventType =
      "award";
  } else if (
    containsAny(
      text,
      [
        "prolongation",
        "contrat",
        "renouvelle",
        "renouvellement",
        "extension",
      ]
    )
  ) {
    eventType =
      "contract";
  } else if (
    containsAny(
      text,
      [
        "calendrier",
        "programme",
        "programmation",
        "horaire",
        "date",
      ]
    )
  ) {
    eventType =
      "schedule";
  }

  const people =
    extractKnownPeople(
      text
    );

  const opponents =
    extractOpponents(
      text
    );

  const competitions =
    extractCompetitions(
      text
    );

  const tokens =
    meaningfulTokens(
      text
    );

  const specificTokens =
    tokens.filter(
      (token) =>
        token.length >=
          5 &&
        !GENERIC_STORY_WORDS.has(
          token
        )
    );

  return {
    eventType,
    people,
    opponents,
    competitions,
    specificTokens,
  };
}

const KNOWN_PEOPLE = [
  "kylian mbappe",
  "mbappe",
  "ousmane dembele",
  "dembele",
  "desire doue",
  "doue",
  "bradley barcola",
  "barcola",
  "achraf hakimi",
  "hakimi",
  "vitinha",
  "marquinhos",
  "nuno mendes",
  "khvicha kvaratskhelia",
  "kvaratskhelia",
  "joao neves",
  "fabian ruiz",
  "willian pacho",
  "pacho",
  "goncalo ramos",
  "ramos",
  "warren zaire emery",
  "zaire emery",
  "lucas hernandez",
  "luis enrique",
  "jerome rothen",
  "rothen",
];

const KNOWN_OPPONENTS = [
  "monaco",
  "as monaco",
  "marseille",
  "om",
  "lyon",
  "ol",
  "lens",
  "lille",
  "nice",
  "rennes",
  "auxerre",
  "strasbourg",
  "toulouse",
  "nantes",
  "brest",
  "le havre",
  "lorient",
  "angers",
  "metz",
  "saint etienne",
  "montpellier",
  "reims",
  "bratislava",
  "slovan bratislava",
  "real madrid",
  "barcelone",
  "barcelona",
  "liverpool",
  "arsenal",
  "manchester city",
  "bayern munich",
  "juventus",
  "milan",
  "inter milan",
];

const GENERIC_STORY_WORDS =
  new Set([
    "psg",
    "paris",
    "saint",
    "germain",
    "football",
    "foot",
    "club",
    "equipe",
    "match",
    "ligue",
    "champions",
    "league",
    "actualite",
    "news",
    "sport",
    "france",
    "francais",
    "francaise",
    "aujourd",
    "hui",
    "dernier",
    "derniere",
    "nouveau",
    "nouvelle",
    "gros",
    "grosse",
    "important",
    "importante",
    "joueur",
    "joueurs",
  ]);

function extractKnownPeople(
  text: string
): string[] {
  const found: string[] =
    [];

  for (
    const person of KNOWN_PEOPLE
  ) {
    if (
      text.includes(
        person
      )
    ) {
      found.push(
        person
      );
    }
  }

  return [
    ...new Set(
      found
    ),
  ];
}

function extractOpponents(
  text: string
): string[] {
  const found: string[] =
    [];

  for (
    const opponent of KNOWN_OPPONENTS
  ) {
    if (
      text.includes(
        opponent
      )
    ) {
      found.push(
        opponent
      );
    }
  }

  const normalized: string[] =
    [];

  for (
    const opponent of found
  ) {
    if (
      opponent ===
        "as monaco" ||
      opponent ===
        "monaco"
    ) {
      normalized.push(
        "monaco"
      );
    } else if (
      opponent ===
        "om" ||
      opponent ===
        "marseille"
    ) {
      normalized.push(
        "marseille"
      );
    } else if (
      opponent ===
        "ol" ||
      opponent ===
        "lyon"
    ) {
      normalized.push(
        "lyon"
      );
    } else if (
      opponent ===
        "slovan bratislava" ||
      opponent ===
        "bratislava"
    ) {
      normalized.push(
        "bratislava"
      );
    } else if (
      opponent ===
        "barcelona" ||
      opponent ===
        "barcelone"
    ) {
      normalized.push(
        "barcelone"
      );
    } else {
      normalized.push(
        opponent
      );
    }
  }

  return [
    ...new Set(
      normalized
    ),
  ];
}

function extractCompetitions(
  text: string
): string[] {
  const competitions: string[] =
    [];

  if (
    containsAny(
      text,
      [
        "ligue 1",
        "ligue1",
      ]
    )
  ) {
    competitions.push(
      "ligue1"
    );
  }

  if (
    containsAny(
      text,
      [
        "ligue des champions",
        "champions league",
        "uefa champions league",
      ]
    )
  ) {
    competitions.push(
      "champions_league"
    );
  }

  if (
    containsAny(
      text,
      [
        "europa league",
        "ligue europa",
      ]
    )
  ) {
    competitions.push(
      "europa_league"
    );
  }

  if (
    containsAny(
      text,
      [
        "conference league",
        "ligue conference",
      ]
    )
  ) {
    competitions.push(
      "conference_league"
    );
  }

  if (
    containsAny(
      text,
      [
        "ballon d'or",
        "ballon d or",
      ]
    )
  ) {
    competitions.push(
      "ballon_dor"
    );
  }

  return [
    ...new Set(
      competitions
    ),
  ];
}

function meaningfulTokens(
  text: string
): string[] {
  return text
    .replace(
      /[^a-z0-9àâçéèêëîïôûùüÿœæ -]/gi,
      " "
    )
    .split(
      /\s+/
    )
    .filter(Boolean)
    .filter(
      (token) =>
        token.length >=
          4 &&
        !GENERIC_STORY_WORDS.has(
          token
        )
    );
}

function hasOverlap(
  a: string[],
  b: string[]
): boolean {
  return a.some(
    (value) =>
      b.includes(
        value
      )
  );
}

function containsAny(
  text: string,
  values: string[]
): boolean {
  return values.some(
    (value) =>
      text.includes(
        value
      )
  );
}

function titleSimilarity(
  a: string,
  b: string
): number {
  const tokensA =
    new Set(
      meaningfulTokens(
        normalizeForComparison(
          a
        )
      )
    );

  const tokensB =
    new Set(
      meaningfulTokens(
        normalizeForComparison(
          b
        )
      )
    );

  if (
    tokensA.size ===
      0 ||
    tokensB.size ===
      0
  ) {
    return 0;
  }

  let intersection =
    0;

  for (
    const token of tokensA
  ) {
    if (
      tokensB.has(
        token
      )
    ) {
      intersection++;
    }
  }

  const union =
    new Set([
      ...tokensA,
      ...tokensB,
    ]).size;

  return union ===
    0
    ? 0
    : intersection /
        union;
}

function clusterPriorityScore(
  cluster: FeedItem[]
): number {
  const sourcePriority =
    Math.max(
      ...cluster.map(
        (item) =>
          item.priority
      )
    );

  const recency =
    Math.max(
      ...cluster.map(
        (item) =>
          item.publishedAt.getTime()
      )
    );

  const ageHours =
    Math.max(
      0,
      (Date.now() -
        recency) /
        (1000 *
          60 *
          60)
    );

  const recencyScore =
    Math.max(
      0,
      10 -
        ageHours /
          6
    );

  const sourceCount =
    new Set(
      cluster.map(
        (item) =>
          item.source
      )
    ).size;

  return (
    sourcePriority *
      4 +
    sourceCount *
      3 +
    recencyScore
  );
}

async function enrichCluster(
  cluster: FeedItem[]
): Promise<{
  sources: EnrichedSource[];
  pagesFetched: number;
  pagesFailed: number;
  characters: number;
  errors: string[];
}> {
  const sources:
    EnrichedSource[] =
    [];

  let pagesFetched =
    0;

  let pagesFailed =
    0;

  let characters =
    0;

  const errors: string[] =
    [];

  const sortedCluster =
    [...cluster]
      .sort(
        (a, b) =>
          b.priority -
            a.priority ||
          b.publishedAt.getTime() -
            a.publishedAt.getTime()
      )
      .slice(
        0,
        MAX_SOURCE_PAGES
      );

  for (
    const item of sortedCluster
  ) {
    let pageText =
      "";

    if (
      item.description &&
      countWords(
        item.description
      ) >= 80
    ) {
      pageText =
        item.description.slice(
          0,
          MAX_SOURCE_TEXT_LENGTH
        );
    } else {
      try {
        pageText =
          await fetchSourcePage(
            item.link
          );

        if (
          pageText
        ) {
          pagesFetched++;
        } else {
          pagesFailed++;
        }
      } catch (error) {
        pagesFailed++;

        errors.push(
          `${item.source}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`
        );
      }
    }

    const combinedText =
      pageText ||
      item.description ||
      "";

    characters +=
      combinedText.length;

    sources.push({
      title:
        item.title,

      source:
        item.source,

      url:
        item.link,

      publishedAt:
        item.publishedAt.toISOString(),

      description:
        item.description,

      pageText:
        combinedText.slice(
          0,
          MAX_SOURCE_TEXT_LENGTH
        ),
    });
  }

  return {
    sources,

    pagesFetched,

    pagesFailed,

    characters,

    errors,
  };
}

async function fetchSourcePage(
  url: string
): Promise<string> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      SOURCE_PAGE_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            Accept:
              "text/html,application/xhtml+xml",

            "User-Agent":
              "PSGDirectBot/1.0 (+https://psg-direct-app-1ktj.vercel.app)",
          },

          cache:
            "no-store",

          signal:
            controller.signal,
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const html =
      await response.text();

    return extractPageContent(
      html
    );
  } finally {
    clearTimeout(
      timeout
    );
  }
}

function extractPageContent(
  html: string
): string {
  let cleaned =
    html;

  cleaned =
    cleaned.replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      " "
    );

  cleaned =
    cleaned.replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/gi,
      " "
    );

  cleaned =
    cleaned.replace(
      /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
      " "
    );

  cleaned =
    cleaned.replace(
      /<(nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " "
    );

  let content =
    "";

  const articleMatch =
    cleaned.match(
      /<article\b[^>]*>([\s\S]*?)<\/article>/i
    );

  if (
    articleMatch?.[1]
  ) {
    content =
      articleMatch[1];
  } else {
    const mainMatch =
      cleaned.match(
        /<main\b[^>]*>([\s\S]*?)<\/main>/i
      );

    if (
      mainMatch?.[1]
    ) {
      content =
        mainMatch[1];
    } else {
      const paragraphs =
        cleaned.match(
          /<p\b[^>]*>[\s\S]*?<\/p>/gi
        );

      content =
        paragraphs?.join(
          " "
        ) ||
        cleaned;
    }
  }

  content =
    content.replace(
      /<[^>]+>/g,
      " "
    );

  content =
    decodeHtmlEntities(
      content
    );

  content =
    content
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return content.slice(
    0,
    MAX_SOURCE_TEXT_LENGTH
  );
}

async function generateArticle(
  cluster: FeedItem[],
  enrichedSources: EnrichedSource[]
): Promise<GenerationResult> {
  const sourceBlocks =
    enrichedSources
      .map(
        (source, index) =>
          `
SOURCE ${index + 1}
Média : ${source.source}
Titre : ${source.title}
Date : ${source.publishedAt}
URL : ${source.url}

Résumé RSS :
${source.description || "(aucun)"}

Contenu récupéré depuis la source :
${source.pageText || "(aucun)"}
`
      )
      .join(
        "\n\n"
      );

  const clusterTitles =
    cluster
      .map(
        (item) =>
          `- ${item.source}: ${item.title}`
      )
      .join(
        "\n"
      );

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Tu dois écrire UN SEUL article de presse sportive original à partir de plusieurs sources parlant du MÊME sujet.

IMPORTANT :
Les sources peuvent contenir des informations redondantes.
Tu dois FUSIONNER les informations qui parlent réellement du même événement.
Tu ne dois surtout PAS mélanger plusieurs sujets différents.

TITRES DU GROUPE :
${clusterTitles}

SOURCES DETAILLEES :
${sourceBlocks}

OBJECTIF :
Produire un article factuel, précis, naturel et intéressant sur le sujet commun de ces sources.

REGLES ABSOLUES :

1. N'invente aucune information.
2. N'invente aucune date, heure, stade, chaîne TV, compétition, joueur, entraîneur ou déclaration.
3. Si une information n'est présente dans aucune source, ne la donne pas comme un fait.
4. Si une information apparaît dans une seule source fiable, tu peux la mentionner avec prudence.
5. Si plusieurs sources confirment une information, utilise-la naturellement.
6. Ne fusionne jamais deux événements différents simplement parce qu'ils concernent le PSG.
7. Ne transforme pas plusieurs actualités différentes en une seule histoire.
8. L'article doit parler d'UN sujet précis.
9. Les informations importantes doivent être concrètes.
10. Évite les phrases génériques lorsqu'une information précise est disponible.

STRUCTURE OBLIGATOIRE :

- Un titre précis et informatif.
- Un chapô de 2 ou 3 phrases.
- Une introduction courte.
- 3 à 5 intertitres Markdown avec "##".
- Des paragraphes courts de 2 à 5 phrases.
- Une conclusion avec "## Ce qu'il faut retenir".

FORMAT :

Titre :
Un titre naturel et précis.

Excerpt :
2 ou 3 phrases résumant l'information principale.

Content :
Le contenu complet avec des paragraphes séparés par des lignes vides.

Utilise Markdown simple.

Exemple :

## Introduction

Premier paragraphe...

## Un événement qui fait réagir

Paragraphe...

## Les informations importantes

Paragraphe...

## Ce que cela change pour le PSG

Paragraphe...

## Ce qu'il faut retenir

Conclusion...

LONGUEUR :
Entre ${MIN_ARTICLE_WORDS} et ${MAX_ARTICLE_WORDS} mots.

STYLE :
- presse sportive française
- naturel
- factuel
- précis
- sans répétition
- sans sensationnalisme artificiel
- pas de liste à puces dans le corps de l'article
- pas de remplissage

Réponds UNIQUEMENT avec un JSON valide :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}
`;

  const result =
    await callGemini(
      prompt
    );

  if (
    "error" in result
  ) {
    return result;
  }

  const parsed =
    parseGeminiJson(
      result.text
    );

  if (
    !parsed
  ) {
    return {
      ok: false,
      error:
        "Réponse Gemini JSON invalide.",
    };
  }

  const title =
    typeof parsed.title ===
    "string"
      ? parsed.title.trim()
      : "";

  const excerpt =
    typeof parsed.excerpt ===
    "string"
      ? parsed.excerpt.trim()
      : "";

  const content =
    typeof parsed.content ===
    "string"
      ? parsed.content.trim()
      : "";

  if (
    !title ||
    !excerpt ||
    !content
  ) {
    return {
      ok: false,
      error:
        "Réponse Gemini incomplète.",
    };
  }

  return {
    ok: true,
    result: {
      title,
      excerpt,
      content,
    },
  };
}

async function expandArticle(
  article: {
    title: string;
    excerpt: string;
    content: string;
  },
  cluster: FeedItem[],
  enrichedSources: EnrichedSource[]
): Promise<GenerationResult> {
  const sourceFacts =
    enrichedSources
      .map(
        (source) =>
          `
${source.source}
${source.title}
${source.pageText}
`
      )
      .join(
        "\n"
      );

  const prompt = `
Tu es rédacteur pour PSG Direct.

L'article ci-dessous est trop court.

ARTICLE :
Titre : ${article.title}

Résumé :
${article.excerpt}

Contenu :
${article.content}

SOURCES :
${sourceFacts}

Tu dois enrichir cet article SANS INVENTER DE FAITS.

Conserve strictement le même sujet.
N'ajoute aucun autre événement.
Ajoute uniquement des informations réellement présentes dans les sources.

Tu peux préciser, si les sources le permettent :
- contexte
- date
- heure
- stade
- compétition
- joueurs
- entraîneur
- composition
- déclarations
- conséquences
- historique directement lié au sujet

Structure obligatoire :

## Introduction

## Intertitre pertinent

## Intertitre pertinent

## Intertitre pertinent

## Ce qu'il faut retenir

Paragraphes courts et séparés par des lignes vides.

Objectif :
entre ${MIN_ARTICLE_WORDS} et ${MAX_ARTICLE_WORDS} mots.

Réponds uniquement en JSON :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}
`;

  const result =
    await callGemini(
      prompt
    );

  if (
    "error" in result
  ) {
    return result;
  }

  const parsed =
    parseGeminiJson(
      result.text
    );

  if (
    !parsed
  ) {
    return {
      ok: false,
      error:
        "JSON invalide lors de l'expansion.",
    };
  }

  if (
    typeof parsed.title !==
      "string" ||
    typeof parsed.excerpt !==
      "string" ||
    typeof parsed.content !==
      "string"
  ) {
    return {
      ok: false,
      error:
        "Expansion Gemini incomplète.",
    };
  }

  return {
    ok: true,
    result: {
      title:
        parsed.title.trim(),

      excerpt:
        parsed.excerpt.trim(),

      content:
        parsed.content.trim(),
    },
  };
}

async function callGemini(
  prompt: string
): Promise<
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const models = [
    {
      model:
        "gemini-3.5-flash-lite",
      timeout:
        4500,
    },
    {
      model:
        "gemini-3.6-flash",
      timeout:
        1500,
    },
  ];

  let lastError =
    "Gemini indisponible.";

  for (
    const config of models
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        config.timeout
      );

    try {
      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body:
              JSON.stringify({
                contents: [
                  {
                    role:
                      "user",

                    parts: [
                      {
                        text:
                          prompt,
                      },
                    ],
                  },
                ],

                generationConfig:
                  {
                    temperature:
                      0.35,

                    maxOutputTokens:
                      2200,

                    responseMimeType:
                      "application/json",
                  },
              }),

            signal:
              controller.signal,
          }
        );

      if (
        !response.ok
      ) {
        lastError =
          `Gemini ${config.model}: HTTP ${response.status}`;

        continue;
      }

      const data =
        await response.json();

      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;

      if (
        typeof text !==
          "string" ||
        !text.trim()
      ) {
        lastError =
          `Gemini ${config.model}: réponse vide`;

        continue;
      }

      return {
        ok: true,
        text:
          text.trim(),
      };
    } catch (error) {
      lastError =
        error instanceof Error
          ? `Gemini ${config.model}: ${error.message}`
          : `Gemini ${config.model}: ${String(error)}`;
    } finally {
      clearTimeout(
        timeout
      );
    }
  }

  return {
    ok: false,
    error:
      lastError,
  };
}

function parseGeminiJson(
  text: string
): GeminiResponse | null {
  let cleaned =
    text.trim();

  if (
    cleaned.startsWith(
      "```json"
    )
  ) {
    cleaned =
      cleaned.slice(
        7
      );
  }

  if (
    cleaned.startsWith(
      "```"
    )
  ) {
    cleaned =
      cleaned.slice(
        3
      );
  }

  if (
    cleaned.endsWith(
      "```"
    )
  ) {
    cleaned =
      cleaned.slice(
        0,
        -3
      );
  }

  cleaned =
    cleaned.trim();

  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    const start =
      cleaned.indexOf(
        "{"
      );

    const end =
      cleaned.lastIndexOf(
        "}"
      );

    if (
      start ===
        -1 ||
      end ===
        -1 ||
      end <=
        start
    ) {
      return null;
    }

    try {
      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
    } catch {
      return null;
    }
  }
}

function normalizeArticleStructure(
  content: string
): string {
  let text =
    decodeHtmlEntities(
      content
    )
      .replace(
        /\r\n/g,
        "\n"
      )
      .replace(
        /\r/g,
        "\n"
      );

  text =
    text.replace(
      /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
      "\n\n"
    );

  text =
    text.replace(
      /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
      "\n\n## $1\n\n"
    );

  text =
    text.replace(
      /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
      "\n\n## $1\n\n"
    );

  text =
    text.replace(
      /<p[^>]*>([\s\S]*?)<\/p>/gi,
      "\n\n$1\n\n"
    );

  text =
    text.replace(
      /<br\s*\/?>/gi,
      "\n"
    );

  text =
    text.replace(
      /<strong[^>]*>([\s\S]*?)<\/strong>/gi,
      "$1"
    );

  text =
    text.replace(
      /<b[^>]*>([\s\S]*?)<\/b>/gi,
      "$1"
    );

  text =
    text.replace(
      /<em[^>]*>([\s\S]*?)<\/em>/gi,
      "$1"
    );

  text =
    stripHtml(
      text
    );

  const rawLines =
    text
      .split("\n")
      .map(
        (line) =>
          line
            .replace(
              /\s+/g,
              " "
            )
            .trim()
      );

  const lines: string[] =
    [];

  for (
    const line of rawLines
  ) {
    if (!line) {
      if (
        lines.length >
          0 &&
        lines[
          lines.length - 1
        ] !== ""
      ) {
        lines.push(
          ""
        );
      }

      continue;
    }

    if (
      /^#{2,3}\s+/.test(
        line
      )
    ) {
      if (
        lines.length >
          0 &&
        lines[
          lines.length - 1
        ] !== ""
      ) {
        lines.push(
          ""
        );
      }

      lines.push(
        line.replace(
          /^#{3}\s+/,
          "## "
        )
      );

      lines.push(
        ""
      );

      continue;
    }

    lines.push(
      line
    );
  }

  text =
    lines
      .join("\n")
      .replace(
        /\n{3,}/g,
        "\n\n"
      )
      .trim();

  return ensureParagraphBreaks(
    text
  );
}

function ensureParagraphBreaks(
  text: string
): string {
  const lines =
    text
      .split("\n")
      .map(
        (line) =>
          line.trim()
      );

  const result: string[] =
    [];

  let paragraph: string[] =
    [];

  const flush =
    () => {
      if (
        paragraph.length >
        0
      ) {
        result.push(
          paragraph.join(
            " "
          )
        );

        paragraph =
          [];
      }
    };

  for (
    const line of lines
  ) {
    if (!line) {
      flush();

      if (
        result.length >
          0 &&
        result[
          result.length - 1
        ] !== ""
      ) {
        result.push(
          ""
        );
      }

      continue;
    }

    if (
      /^##\s+/.test(
        line
      )
    ) {
      flush();

      if (
        result.length >
          0 &&
        result[
          result.length - 1
        ] !== ""
      ) {
        result.push(
          ""
        );
      }

      result.push(
        line
      );

      result.push(
        ""
      );

      continue;
    }

    paragraph.push(
      line
    );

    if (
      paragraph
        .join(" ")
        .split(
          /\s+/
        )
        .length >=
      75
    ) {
      flush();

      result.push(
        ""
      );
    }
  }

  flush();

  return result
    .join("\n")
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

function trimArticleToWordLimit(
  content: string,
  maxWords: number
): string {
  const words =
    content.split(
      /\s+/
    );

  if (
    words.length <=
    maxWords
  ) {
    return content;
  }

  return (
    words
      .slice(
        0,
        maxWords
      )
      .join(" ")
      .replace(
        /[,:;.!?]+$/,
        ""
      ) +
    "."
  );
}

async function makeUniqueSlug(
  baseSlug: string
): Promise<string> {
  const cleanBase =
    baseSlug
      .trim()
      .replace(
        /^-+|-+$/g,
        ""
      );

  if (
    !cleanBase
  ) {
    return "";
  }

  let slug =
    cleanBase;

  let counter =
    2;

  while (true) {
    const existing =
      await prisma.article.findUnique(
        {
          where: {
            slug,
          },

          select: {
            id: true,
          },
        }
      );

    if (
      !existing
    ) {
      return slug;
    }

    slug =
      `${cleanBase}-${counter}`;

    counter++;

    if (
      counter >
      100
    ) {
      return "";
    }
  }
}

function slugify(
  text: string
): string {
  return normalizeForComparison(
    text
  )
    .replace(
      /['’]/g,
      ""
    )
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    );
}

function normalizeTitle(
  title: string
): string {
  return normalizeForComparison(
    title
  )
    .replace(
      /\s*[-|:]\s*(rmc sport|foot mercato|culturepsg|sports\.fr|le10sport|dicodusport|sport\.fr).*$/i,
      ""
    )
    .replace(
      /\bpsg\b/g,
      "paris"
    )
    .trim();
}

function normalizeForComparison(
  text: string
): string {
  return decodeHtmlEntities(
    stripHtml(
      text
    )
  )
    .normalize(
      "NFD"
    )
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

function normalizeText(
  text: string
): string {
  return decodeHtmlEntities(
    stripHtml(
      text
    )
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function normalizeUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(
        url
      );

    parsed.hash =
      "";

    parsed.searchParams.delete(
      "utm_source"
    );

    parsed.searchParams.delete(
      "utm_medium"
    );

    parsed.searchParams.delete(
      "utm_campaign"
    );

    parsed.searchParams.delete(
      "utm_content"
    );

    parsed.searchParams.delete(
      "utm_term"
    );

    return parsed
      .toString()
      .replace(
        /\/$/,
        ""
      );
  } catch {
    return url
      .trim()
      .replace(
        /\/$/,
        ""
      );
  }
}

function countWords(
  text: string
): number {
  return text
    .trim()
    .split(
      /\s+/
    )
    .filter(
      Boolean
    )
    .length;
}

function stripHtml(
  text: string
): string {
  return text.replace(
    /<[^>]*>/g,
    " "
  );
}

function decodeHtmlEntities(
  text: string
): string {
  return text
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
          Number(
            code
          )
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
