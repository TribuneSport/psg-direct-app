import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

type FeedItem = {
  title: string;
  description: string;
  link: string;
  pubDate: string;
  source: string;
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

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  /*
   * =========================================================
   * AUTHENTIFICATION
   * =========================================================
   */

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
        error: "GEMINI_API_KEY is missing",
      },
      {
        status: 500,
      }
    );
  }

  const diagnostics: Diagnostic[] = [];

  const rssErrors: string[] = [];
  const sourcePageErrors: string[] = [];

  let sourcePagesFetched = 0;
  let sourcePagesFailed = 0;
  let enrichedCharacters = 0;
  let geminiCalls = 0;

  try {
    /*
     * =========================================================
     * 1. RÉCUPÉRATION RSS
     * =========================================================
     */

    const feeds = await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        try {
          const xml = await fetchWithTimeout(
            feed.url,
            RSS_TIMEOUT_MS,
            {
              headers: {
                Accept:
                  "application/rss+xml, application/xml, text/xml, */*",
                "User-Agent": "PSG-Direct/1.0",
              },
            }
          );

          return {
            feed: feed.name,
            items: parseRSS(xml, feed.name),
            error: null as string | null,
          };
        } catch (error) {
          return {
            feed: feed.name,
            items: [] as FeedItem[],
            error: getErrorMessage(error),
          };
        }
      })
    );

    for (const result of feeds) {
      if (result.error) {
        rssErrors.push(
          `${result.feed}: ${result.error}`
        );
      }
    }

    const allItems = feeds.flatMap(
      (result) => result.items
    );

    /*
     * =========================================================
     * 2. FILTRE PSG
     * =========================================================
     */

    const relevantItems = allItems.filter(
      isRelevantPSG
    );

    /*
     * =========================================================
     * 3. DÉDUPLICATION RSS
     * =========================================================
     */

    const uniqueItems = deduplicateItems(
      relevantItems
    );

    /*
     * =========================================================
     * 4. ARTICLES EXISTANTS
     * =========================================================
     */

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

    const newItems = uniqueItems.filter(
      (item) =>
        !isAlreadyStored(
          item,
          recentArticles
        )
    );

    /*
     * =========================================================
     * 5. CONSTRUCTION DES CLUSTERS
     * =========================================================
     */

    const clusters = buildSimpleClusters(
      newItems
    );

    const candidateClusters = clusters
      .filter(
        (cluster) =>
          cluster.length > 0
      )
      .sort(
        (a, b) =>
          clusterPriority(b) -
          clusterPriority(a)
      );

    /*
     * =========================================================
     * 6. OBJECTIF QUOTIDIEN
     * =========================================================
     */

    const startOfToday =
      getStartOfToday();

    const articlesCreatedToday =
      await prisma.article.count({
        where: {
          club: "PSG",
          isAiGenerated: true,
          createdAt: {
            gte: startOfToday,
          },
        },
      });

    const remainingDailyTarget =
      Math.max(
        0,
        DAILY_TARGET -
          articlesCreatedToday
      );

    const requestedCount =
      remainingDailyTarget > 0
        ? Math.min(
            MAX_NEW_ARTICLES_PER_RUN,
            remainingDailyTarget,
            candidateClusters.length
          )
        : Math.min(
            MAX_NEW_ARTICLES_PER_RUN,
            candidateClusters.length
          );

    const selectedClusters =
      candidateClusters.slice(
        0,
        requestedCount
      );

    /*
     * =========================================================
     * 7. TRAITEMENT PARALLÈLE
     * =========================================================
     *
     * Les clusters sont indépendants.
     *
     * Cela évite :
     *
     * cluster 1 -> Gemini -> attendre
     * cluster 2 -> Gemini -> attendre
     * cluster 3 -> Gemini -> attendre
     *
     * et permet :
     *
     * cluster 1 ─┐
     * cluster 2 ─┼── traitement parallèle
     * cluster 3 ─┘
     *
     * Cette modification permet de conserver une durée
     * suffisamment courte pour cron-job.org.
     */

    const articlesForDuplicateCheck = [
      ...recentArticles,
    ];

    const clusterResults =
      await Promise.all(
        selectedClusters.map(
          (
            cluster,
            index
          ) =>
            processCluster(
              cluster,
              articlesForDuplicateCheck,
              index + 1
            )
        )
      );

    /*
     * =========================================================
     * 8. AGRÉGATION DES RÉSULTATS
     * =========================================================
     */

    let created = 0;
    let skipped = 0;

    for (const result of clusterResults) {
      diagnostics.push(
        result.diagnostic
      );

      geminiCalls +=
        result.geminiCalls;

      sourcePagesFetched +=
        result.enrichment
          .pagesFetched;

      sourcePagesFailed +=
        result.enrichment
          .pagesFailed;

      enrichedCharacters +=
        result.enrichment
          .enrichedCharacters;

      sourcePageErrors.push(
        ...result.enrichment
          .pageErrors
      );

      if (result.created) {
        created++;
      } else {
        skipped++;
      }
    }

    /*
     * =========================================================
     * 9. RÉSULTAT FINAL
     * =========================================================
     */

    const totalCreatedToday =
      articlesCreatedToday +
      created;

    return NextResponse.json({
      checked:
        allItems.length,

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
          0,
          candidateClusters.length -
            selectedClusters.length
        ),

      created,

      skipped,

      articlesCreatedToday:
        totalCreatedToday,

      dailyTarget:
        DAILY_TARGET,

      remainingDailyTarget:
        Math.max(
          0,
          DAILY_TARGET -
            totalCreatedToday
        ),

      dailyTargetReached:
        totalCreatedToday >=
        DAILY_TARGET,

      sourcesOk:
        feeds
          .filter(
            (feed) =>
              !feed.error
          )
          .map(
            (feed) =>
              feed.feed
          ),

      sources:
        RSS_FEEDS.map(
          (feed) =>
            feed.name
        ),

      duplicates:
        uniqueItems.length -
        newItems.length,

      fusion: true,
      optimized: true,
      enrichment: true,
      simplified: true,
      unlimitedDailyCap: true,

      diagnostics: {
        geminiCalls,

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
                  "generation_error" ||
                item.outcome ===
                  "gemini_quota_exceeded"
            )
            .map(
              (item) =>
                item.detail
            ),

        invalidJson:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "invalid_json"
          ).length,

        tooShort:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "too_short"
          ).length,

        tooShortAfterRetry:
          diagnostics.filter(
            (item) =>
              item.outcome ===
              "too_short_after_retry"
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
              "create_error"
          ).length,

        rssErrors,

        sourcePagesFetched,

        sourcePagesFailed,

        enrichedCharacters,

        sourcePageErrors,

        clusters:
          diagnostics,
      },

      elapsedMs:
        Date.now() -
        startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          getErrorMessage(error),

        elapsedMs:
          Date.now() -
          startedAt,
      },
      {
        status: 500,
      }
    );
  }
}

/*
 * =========================================================
 * PROCESS CLUSTER
 * =========================================================
 */

async function processCluster(
  cluster: FeedItem[],
  recentArticles: Array<{
    title: string;
    slug: string;
    sourceUrl: string | null;
  }>,
  clusterNumber: number
): Promise<{
  created: boolean;
  articleTitle: string | null;
  sourceUrl: string | null;
  diagnostic: Diagnostic;
  enrichment: EnrichmentResult;
  geminiCalls: number;
}> {
  const sources = [
    ...new Set(
      cluster.map(
        (item) =>
          item.source
      )
    ),
  ];

  const titles = cluster.map(
    (item) =>
      item.title
  );

  const sorted = [...cluster]
    .sort(
      (a, b) =>
        sourcePriority(b.source) -
        sourcePriority(a.source)
    )
    .slice(
      0,
      MAX_SOURCES_PER_ARTICLE
    );

  const enrichment =
    await enrichSources(
      sorted,
      cluster
    );

  const sourceInputs =
    enrichment.sources;

  if (
    sourceInputs.length === 0
  ) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,
      enrichment,
      geminiCalls: 0,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "no_sources",
        detail:
          "Aucune source exploitable.",
      },
    };
  }

  /*
   * =========================================================
   * PREMIÈRE GÉNÉRATION
   * =========================================================
   */

  let geminiCallsForCluster = 0;

  const firstGeneration =
    await generateArticle(
      sourceInputs
    );

  geminiCallsForCluster++;

  if (
    firstGeneration.quotaExceeded
  ) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "gemini_quota_exceeded",
        detail:
          firstGeneration.error ||
          "Gemini quota exceeded.",
      },
    };
  }

  if (
    !firstGeneration.article
  ) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          firstGeneration.error?.includes(
            "JSON"
          )
            ? "invalid_json"
            : "generation_error",
        detail:
          firstGeneration.error ||
          "Gemini n'a pas généré d'article.",
      },
    };
  }

  let article =
    normalizeArticle(
      firstGeneration.article
    );

  /*
   * =========================================================
   * RETRY SI ARTICLE TROP COURT
   * =========================================================
   */

  if (
    countWords(
      article.content
    ) < MIN_ARTICLE_WORDS
  ) {
    const retry =
      await generateArticle(
        sourceInputs,
        true,
        article
      );

    geminiCallsForCluster++;

    if (
      retry.quotaExceeded
    ) {
      return {
        created: false,
        articleTitle: null,
        sourceUrl: null,
        enrichment,
        geminiCalls:
          geminiCallsForCluster,
        diagnostic: {
          cluster: clusterNumber,
          sources,
          titles,
          outcome:
            "gemini_quota_exceeded",
          detail:
            retry.error ||
            "Gemini quota exceeded during retry.",
        },
      };
    }

    if (retry.article) {
      article =
        normalizeArticle(
          retry.article
        );
    }
  }

  /*
   * =========================================================
   * DEUXIÈME RETRY SI TOUJOURS TROP COURT
   * =========================================================
   *
   * Ce retry reste limité.
   *
   * En cas de 429, nous sortons immédiatement.
   */

  if (
    countWords(
      article.content
    ) < MIN_ARTICLE_WORDS
  ) {
    const retry =
      await generateArticle(
        sourceInputs,
        true,
        article,
        true
      );

    geminiCallsForCluster++;

    if (
      retry.quotaExceeded
    ) {
      return {
        created: false,
        articleTitle: null,
        sourceUrl: null,
        enrichment,
        geminiCalls:
          geminiCallsForCluster,
        diagnostic: {
          cluster: clusterNumber,
          sources,
          titles,
          outcome:
            "gemini_quota_exceeded",
          detail:
            retry.error ||
            "Gemini quota exceeded during second retry.",
        },
      };
    }

    if (retry.article) {
      article =
        normalizeArticle(
          retry.article
        );
    }
  }

  const articleWords =
    countWords(
      article.content
    );

  /*
   * =========================================================
   * ARTICLE TROP COURT
   * =========================================================
   */

  if (
    articleWords <
    MIN_ARTICLE_WORDS
  ) {
    return {
      created: false,
      articleTitle:
        article.title,
      sourceUrl:
        sorted[0]?.link ||
        null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "too_short_after_retry",
        detail:
          `title=${article.title.length}, words=${articleWords}, excerpt=${article.excerpt.length}`,
      },
    };
  }

  /*
   * =========================================================
   * DÉTECTION DES DOUBLONS
   * =========================================================
   */

  const duplicate =
    recentArticles.some(
      (existing) =>
        titleSimilarity(
          article.title,
          existing.title
        ) >= 0.9
    );

  if (duplicate) {
    return {
      created: false,
      articleTitle:
        article.title,
      sourceUrl:
        sorted[0]?.link ||
        null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "duplicate",
        detail:
          "Article similaire déjà présent dans la base.",
      },
    };
  }

  /*
   * =========================================================
   * SLUG
   * =========================================================
   */

  let slug: string;

  try {
    slug =
      await makeUniqueSlug(
        article.title
      );
  } catch (error) {
    return {
      created: false,
      articleTitle:
        article.title,
      sourceUrl:
        sorted[0]?.link ||
        null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "slug_error",
        detail:
          getErrorMessage(
            error
          ),
      },
    };
  }

  /*
   * =========================================================
   * CRÉATION PRISMA
   * =========================================================
   */

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

        club: "PSG",

        status: "DRAFT",

        isAiGenerated:
          true,

        sourceUrl:
          sorted[0]?.link ||
          null,
      },
    });

    return {
      created: true,
      articleTitle:
        article.title,
      sourceUrl:
        sorted[0]?.link ||
        null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "created",
        detail:
          `Article créé en DRAFT. ${articleWords} mots.`,
      },
    };
  } catch (error) {
    return {
      created: false,
      articleTitle:
        article.title,
      sourceUrl:
        sorted[0]?.link ||
        null,
      enrichment,
      geminiCalls:
        geminiCallsForCluster,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "create_error",
        detail:
          getErrorMessage(
            error
          ),
      },
    };
  }
}

/*
 * =========================================================
 * ENRICHISSEMENT DES SOURCES
 * =========================================================
 */

async function enrichSources(
  cluster: FeedItem[],
  fullCluster: FeedItem[]
): Promise<EnrichmentResult> {
  const sources: ArticleInput[] = [];

  let pagesFetched = 0;
  let pagesFailed = 0;
  let enrichedCharacters = 0;

  const pageErrors: string[] = [];

  const enriched =
    await Promise.all(
      cluster.map(
        async (item) => {
          const baseDescription =
            cleanText(
              stripHtml(
                item.description
              )
            );

          const shouldFetch =
            shouldFetchSourcePage(
              item,
              fullCluster
            );

          if (!shouldFetch) {
            return {
              ...item,
              description:
                baseDescription,
              pageText: "",
              pageFetched: false,
              pageError: null as string | null,
            };
          }

          try {
            const html =
              await fetchWithTimeout(
                item.link,
                SOURCE_TIMEOUT_MS,
                {
                  headers: {
                    Accept:
                      "text/html,application/xhtml+xml",
                    "User-Agent":
                      "Mozilla/5.0 PSG-Direct/1.0",
                  },
                }
              );

            const pageText =
              extractPageText(
                html
              );

            return {
              ...item,
              description:
                baseDescription,
              pageText,
              pageFetched:
                pageText.length > 0,
              pageError: null as string | null,
            };
          } catch (error) {
            return {
              ...item,
              description:
                baseDescription,
              pageText: "",
              pageFetched: false,
              pageError:
                getErrorMessage(
                  error
                ),
            };
          }
        }
      )
    );

  for (const item of enriched) {
    let description =
      item.description;

    if (
      item.pageFetched &&
      item.pageText
    ) {
      pagesFetched++;

      enrichedCharacters +=
        item.pageText.length;

      description =
        `${description}\n\nInformations complémentaires de la page source :\n${item.pageText}`;
    } else if (
      item.pageError
    ) {
      pagesFailed++;

      pageErrors.push(
        `${item.source}: ${item.pageError}`
      );
    }

    sources.push({
      title:
        item.title,

      description:
        description.slice(
          0,
          MAX_SOURCE_PAGE_CHARS
        ),

      source:
        item.source,

      link:
        item.link,
    });
  }

  return {
    sources,
    pagesFetched,
    pagesFailed,
    enrichedCharacters,
    pageErrors,
  };
}

/*
 * =========================================================
 * DÉCISION DE RÉCUPÉRATION DE LA PAGE SOURCE
 * =========================================================
 */

function shouldFetchSourcePage(
  item: FeedItem,
  cluster: FeedItem[]
): boolean {
  const description =
    cleanText(
      stripHtml(
        item.description
      )
    );

  const words =
    countWords(
      description
    );

  if (
    words <
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
    sourcePriority(
      item.source
    ) >= 4
  ) {
    return true;
  }

  if (
    description.length < 500
  ) {
    return true;
  }

  const concreteIntent =
    /heure|quelle chaîne|chaîne|composition|compo|blessé|blessure|absent|transfert|mercato|contrat|prolongation|arbitre|stade|parc des princes|pelouse|diffusion|télévision|titulaire|groupe|conférence|match/i;

  if (
    concreteIntent.test(
      item.title
    )
  ) {
    return true;
  }

  const boilerplate =
    /lire la suite|en savoir plus|cliquez|retrouvez|article complet/i;

  if (
    boilerplate.test(
      description
    )
  ) {
    return true;
  }

  return false;
}

/*
 * =========================================================
 * GEMINI
 * =========================================================
 */

async function generateArticle(
  sources: ArticleInput[],
  retry = false,
  previousArticle?: GeminiArticle,
  forceLongRetry = false
): Promise<GeminiCallResult> {
  const sourceText =
    sources
      .map(
        (source, index) =>
          `SOURCE ${index + 1}
Source : ${source.source}
Titre : ${source.title}
URL : ${source.link}
Informations :
${source.description}`
      )
      .join(
        "\n\n==============================\n\n"
      );

  let previousText = "";

  if (previousArticle) {
    previousText = `
ARTICLE PRÉCÉDENT À AMÉLIORER :

Titre :
${previousArticle.title}

Chapô :
${previousArticle.excerpt}

Contenu :
${previousArticle.content}
`;
  }

  const retryInstruction = retry
    ? forceLongRetry
      ? `
L'article précédent est encore trop court.

Produis cette fois un véritable article de presse sportive d'au moins 500 mots lorsque les informations disponibles le permettent.

Tu dois développer les faits réellement présents dans les sources, sans inventer.
`
      : `
L'article précédent était trop court.

Produis un article plus développé, idéalement entre 600 et 800 mots lorsque les informations disponibles le permettent.

N'invente aucune information.
`
    : `
Produis un article complet d'environ 600 à 800 mots lorsque les informations disponibles le permettent.
`;

  const prompt = `
Tu es le rédacteur en chef de PSG Direct, un média français consacré exclusivement au Paris Saint-Germain.

Ta mission est de transformer plusieurs sources d'actualité en UN SEUL article de presse sportive original.

${retryInstruction}

RÈGLES ABSOLUES :

1. Utilise uniquement les informations réellement présentes dans les sources.
2. Ne crée aucune information.
3. N'invente jamais de date.
4. N'invente jamais d'heure.
5. N'invente jamais de chaîne TV.
6. N'invente jamais de composition.
7. N'invente jamais de blessure.
8. N'invente jamais de transfert.
9. N'invente jamais de résultat.
10. N'invente jamais de déclaration.
11. N'invente jamais de joueur.
12. N'invente jamais de lieu.
13. Ne mélange pas deux événements différents.
14. Fusionne uniquement les informations qui concernent le même sujet.
15. Ne cite jamais Gemini.
16. Ne mentionne jamais l'IA.
17. Ne copie pas les phrases des sources.
18. Réécris entièrement avec un style journalistique naturel.
19. Le texte doit être en français.
20. Le ton doit être celui d'un média sportif professionnel.
21. Le contenu doit être structuré avec des titres Markdown lorsque cela est pertinent.
22. Le chapô doit être court et informatif.
23. Le titre doit être clair, naturel et attractif.
24. Si les sources ne permettent pas d'atteindre 600 mots sans inventer, privilégie l'exactitude plutôt que le remplissage.

${previousText}

SOURCES À UTILISER :

${sourceText}

Retourne UNIQUEMENT un JSON valide, sans commentaire avant ou après :

{
  "title": "Titre de l'article",
  "excerpt": "Chapô de l'article",
  "content": "Contenu complet en Markdown"
}
`;

  const result =
    await callGemini(
      prompt
    );

  if (result.error) {
    return {
      article: null,
      error:
        result.error,
      quotaExceeded:
        result.quotaExceeded,
    };
  }

  if (!result.text) {
    return {
      article: null,
      error:
        "Gemini returned an empty response",
      quotaExceeded: false,
    };
  }

  const parsed =
    parseGeminiJson(
      result.text
    );

  if (!parsed) {
    return {
      article: null,
      error:
        "Gemini response is not valid JSON",
      quotaExceeded: false,
    };
  }

  if (
    !isValidGeminiArticle(
      parsed
    )
  ) {
    return {
      article: null,
      error:
        "Gemini JSON does not contain a valid article",
      quotaExceeded: false,
    };
  }

  return {
    article:
      normalizeArticle(
        parsed
      ),
    error: null,
    quotaExceeded: false,
  };
}

/*
 * =========================================================
 * APPEL GEMINI
 * =========================================================
 *
 * IMPORTANT :
 *
 * - On ne multiplie pas les retries quand Gemini retourne 429.
 * - Le second modèle est tenté uniquement pour les erreurs
 *   qui ne correspondent pas à un quota dépassé.
 */

async function callGemini(
  prompt: string
): Promise<{
  text: string | null;
  error: string | null;
  quotaExceeded: boolean;
}> {
  if (!GEMINI_API_KEY) {
    return {
      text: null,
      error:
        "GEMINI_API_KEY is missing",
      quotaExceeded: false,
    };
  }

  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ];

  const errors: string[] = [];

  for (
    let index = 0;
    index < models.length;
    index++
  ) {
    const model =
      models[index];

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        GEMINI_TIMEOUT_MS
      );

    try {
      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: prompt,
                    },
                  ],
                },
              ],

              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4500,
                responseMimeType:
                  "application/json",
              },
            }),

            signal:
              controller.signal,
          }
        );

      const rawText =
        await response.text();

      if (!response.ok) {
        const errorMessage =
          rawText ||
          `${response.status} ${response.statusText}`;

        const is429 =
          response.status === 429 ||
          /quota|resource_exhausted|rate_limit_exceeded|too_many_requests|exceeded your current quota/i.test(
            errorMessage
          );

        if (is429) {
          return {
            text: null,
            error:
              `Gemini ${model}: HTTP 429 - ${errorMessage}`,
            quotaExceeded: true,
          };
        }

        errors.push(
          `Gemini ${model}: HTTP ${response.status} - ${errorMessage}`
        );

        /*
         * On passe au modèle suivant pour une erreur serveur
         * ou une erreur temporaire.
         */
        continue;
      }

      let data: any;

      try {
        data =
          JSON.parse(
            rawText
          );
      } catch {
        errors.push(
          `Gemini ${model}: invalid HTTP JSON response`
        );

        continue;
      }

      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;

      if (
        typeof text ===
          "string" &&
        text.trim()
      ) {
        return {
          text:
            text.trim(),
          error: null,
          quotaExceeded: false,
        };
      }

      errors.push(
        `Gemini ${model}: empty candidate response`
      );
    } catch (error) {
      const message =
        getErrorMessage(
          error
        );

      /*
       * AbortError = timeout local.
       * On ne considère pas cela comme un quota.
       */
      errors.push(
        `Gemini ${model}: ${message}`
      );
    } finally {
      clearTimeout(
        timeout
      );
    }
  }

  return {
    text: null,
    error:
      errors.join(
        " | "
      ) ||
      "Gemini generation failed",
    quotaExceeded: false,
  };
}

/*
 * =========================================================
 * PARSING GEMINI JSON
 * =========================================================
 */

function parseGeminiJson(
  text: string
): GeminiArticle | null {
  const cleaned =
    text
      .trim()
      .replace(
        /^```json\s*/i,
        ""
      )
      .replace(
        /^```\s*/i,
        ""
      )
      .replace(
        /\s*```$/i,
        ""
      )
      .trim();

  try {
    const parsed =
      JSON.parse(
        cleaned
      );

    if (
      isValidGeminiArticle(
        parsed
      )
    ) {
      return parsed;
    }
  } catch {
    // Continue avec extraction.
  }

  const jsonObject =
    extractFirstJsonObject(
      cleaned
    );

  if (!jsonObject) {
    return null;
  }

  try {
    const repaired =
      repairJsonString(
        jsonObject
      );

    const parsed =
      JSON.parse(
        repaired
      );

    if (
      isValidGeminiArticle(
        parsed
      )
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isValidGeminiArticle(
  value: any
): value is GeminiArticle {
  return (
    value &&
    typeof value ===
      "object" &&
    typeof value.title ===
      "string" &&
    typeof value.excerpt ===
      "string" &&
    typeof value.content ===
      "string" &&
    value.title.trim().length >
      0 &&
    value.excerpt.trim().length >
      0 &&
    value.content.trim().length >
      0
  );
}

function extractFirstJsonObject(
  text: string
): string | null {
  const start =
    text.indexOf("{");

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let i = start;
    i < text.length;
    i++
  ) {
    const char =
      text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (
      char === "\\" &&
      inString
    ) {
      escaped = true;
      continue;
    }

    if (
      char === '"'
    ) {
      inString =
        !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (
      char === "{"
    ) {
      depth++;
    }

    if (
      char === "}"
    ) {
      depth--;

      if (depth === 0) {
        return text.slice(
          start,
          i + 1
        );
      }
    }
  }

  return null;
}

function repairJsonString(
  text: string
): string {
  return text
    .replace(
      /,\s*}/g,
      "}"
    )
    .replace(
      /,\s*]/g,
      "]"
    )
    .trim();
}

/*
 * =========================================================
 * NORMALISATION ARTICLE
 * =========================================================
 */

function normalizeArticle(
  article: GeminiArticle
): GeminiArticle {
  let title =
    cleanText(
      article.title
    );

  let excerpt =
    cleanText(
      article.excerpt
    );

  let content =
    cleanArticleContent(
      article.content
    );

  if (
    !title
  ) {
    title =
      "Actualité du PSG";
  }

  if (
    !excerpt
  ) {
    excerpt =
      trimToWords(
        content,
        45
      );
  }

  if (
    !content
  ) {
    content =
      excerpt;
  }

  if (
    countWords(
      content
    ) > MAX_ARTICLE_WORDS
  ) {
    content =
      trimToWords(
        content,
        MAX_ARTICLE_WORDS
      );
  }

  content =
    addBasicStructure(
      content
    );

  return {
    title,
    excerpt,
    content,
  };
}

function addBasicStructure(
  content: string
): string {
  const cleaned =
    content.trim();

  if (
    /^#/m.test(
      cleaned
    )
  ) {
    return cleaned;
  }

  const paragraphs =
    cleaned
      .split(
        /\n\s*\n/
      )
      .map(
        (part) =>
          part.trim()
      )
      .filter(Boolean);

  if (
    paragraphs.length <= 2
  ) {
    return cleaned;
  }

  const first =
    paragraphs[0];

  const rest =
    paragraphs
      .slice(1)
      .join(
        "\n\n"
      );

  return `${first}\n\n${rest}`;
}

function trimToWords(
  text: string,
  maxWords: number
): string {
  const words =
    text
      .trim()
      .split(/\s+/);

  if (
    words.length <=
    maxWords
  ) {
    return text.trim();
  }

  return (
    words
      .slice(
        0,
        maxWords
      )
      .join(" ")
      .replace(
        /[,:;]$/,
        ""
      ) +
    "…"
  );
}

/*
 * =========================================================
 * CLUSTERS
 * =========================================================
 */

function buildSimpleClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters: FeedItem[][] =
    [];

  for (const item of items) {
    const opponent =
      extractOpponent(
        item.title
      );

    const event =
      extractEvent(
        item.title
      );

    let bestCluster:
      FeedItem[] | null =
      null;

    let bestScore = 0;

    for (
      const cluster of clusters
    ) {
      const score =
        similarityToCluster(
          item,
          cluster
        );

      if (
        score >
          bestScore &&
        score >= 0.72
      ) {
        bestScore =
          score;

        bestCluster =
          cluster;
      }
    }

    if (
      bestCluster
    ) {
      const clusterOpponents =
        extractAllOpponents(
          bestCluster
            .map(
              (x) =>
                x.title
            )
            .join(" ")
        );

      if (
        opponent &&
        clusterOpponents.length >
          0 &&
        !clusterOpponents.includes(
          opponent
        )
      ) {
        clusters.push([
          item,
        ]);
        continue;
      }

      bestCluster.push(
        item
      );
    } else {
      clusters.push([
        item,
      ]);
    }

    /*
     * Utilisation de event pour conserver une variable
     * explicitement calculée et éviter les regroupements
     * absurdes sur des titres très courts.
     */
    if (
      event &&
      clusters.length === 0
    ) {
      clusters.push([
        item,
      ]);
    }
  }

  return clusters;
}

function similarityToCluster(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  let best = 0;

  for (
    const existing of cluster
  ) {
    const similarity =
      simpleStorySimilarity(
        item.title,
        existing.title
      );

    if (
      similarity >
      best
    ) {
      best =
        similarity;
    }
  }

  return best;
}

function simpleStorySimilarity(
  a: string,
  b: string
): number {
  const tokensA =
    new Set(
      meaningfulTokens(
        a
      )
    );

  const tokensB =
    new Set(
      meaningfulTokens(
        b
      )
    );

  if (
    tokensA.size === 0 ||
    tokensB.size === 0
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

  return (
    intersection /
    Math.max(
      1,
      union
    )
  );
}

function extractAllOpponents(
  text: string
): string[] {
  const normalized =
    normalizeForComparison(
      text
    );

  const opponents = [
    "Lille",
    "Rennes",
    "Marseille",
    "OM",
    "Lyon",
    "Monaco",
    "Lens",
    "Nantes",
    "Strasbourg",
    "Nice",
    "Brest",
    "Montpellier",
    "Toulouse",
    "Reims",
    "Auxerre",
    "Le Havre",
    "Saint-Etienne",
    "Nîmes",
    "Bordeaux",
    "Angers",
    "Metz",
    "Nantes",
    "Manchester City",
    "Manchester United",
    "Liverpool",
    "Arsenal",
    "Chelsea",
    "Real Madrid",
    "Barcelona",
    "Bayern Munich",
    "Inter Milan",
    "AC Milan",
    "Juventus",
    "Atletico Madrid",
    "Benfica",
    "Sporting",
    "Porto",
    "Slovan Bratislava",
    "Bratislava",
  ];

  return opponents.filter(
    (opponent) =>
      normalized.includes(
        normalizeForComparison(
          opponent
        )
      )
  );
}

function extractOpponent(
  text: string
): string | null {
  const opponents =
    extractAllOpponents(
      text
    );

  if (
    opponents.length !== 1
  ) {
    return null;
  }

  return opponents[0];
}

function extractEvent(
  text: string
): string | null {
  const normalized =
    normalizeForComparison(
      text
    );

  if (
    /composition|compo|titulaire|groupe/.test(
      normalized
    )
  ) {
    return "composition";
  }

  if (
    /heure|chaine|diffusion|television|direct|streaming/.test(
      normalized
    )
  ) {
    return "diffusion";
  }

  if (
    /blessure|blesse|absent|forfait/.test(
      normalized
    )
  ) {
    return "injury";
  }

  if (
    /transfert|mercato|recrute|prolongation|contrat/.test(
      normalized
    )
  ) {
    return "mercato";
  }

  if (
    /match|rencontre|victoire|defaite|nul|score/.test(
      normalized
    )
  ) {
    return "match";
  }

  return null;
}

/*
 * =========================================================
 * DÉDUPLICATION
 * =========================================================
 */

function deduplicateItems(
  items: FeedItem[]
): FeedItem[] {
  const result: FeedItem[] =
    [];

  const seenUrls =
    new Set<string>();

  const seenTitles =
    new Set<string>();

  for (const item of items) {
    const url =
      normalizeUrl(
        item.link
      );

    const title =
      normalizeForComparison(
        item.title
      );

    if (
      url &&
      seenUrls.has(url)
    ) {
      continue;
    }

    if (
      title &&
      seenTitles.has(title)
    ) {
      continue;
    }

    if (url) {
      seenUrls.add(url);
    }

    if (title) {
      seenTitles.add(title);
    }

    result.push(item);
  }

  return result;
}

function isAlreadyStored(
  item: FeedItem,
  articles: Array<{
    title: string;
    slug: string;
    sourceUrl: string | null;
  }>
): boolean {
  const itemUrl =
    normalizeUrl(
      item.link
    );

  return articles.some(
    (article) => {
      if (
        itemUrl &&
        normalizeUrl(
          article.sourceUrl ||
            ""
        ) === itemUrl
      ) {
        return true;
      }

      return (
        titleSimilarity(
          item.title,
          article.title
        ) >= 0.9
      );
    }
  );
}

/*
 * =========================================================
 * FILTRE PSG
 * =========================================================
 */

function isRelevantPSG(
  item: FeedItem
): boolean {
  const text =
    `${item.title} ${item.description}`;

  const normalized =
    normalizeForComparison(
      text
    );

  const psgTerms = [
    "psg",
    "paris saint germain",
    "paris sg",
    "paris-sg",
    "paris saint-germain",
    "parisien",
  ];

  return psgTerms.some(
    (term) =>
      normalized.includes(
        normalizeForComparison(
          term
        )
      )
  );
}

/*
 * =========================================================
 * RSS
 * =========================================================
 */

function parseRSS(
  xml: string,
  source: string
): FeedItem[] {
  const items: FeedItem[] =
    [];

  const itemMatches =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) || [];

  for (
    const itemXml of itemMatches.slice(
      0,
      MAX_ITEMS_PER_SOURCE
    )
  ) {
    const title =
      cleanText(
        decodeHtmlEntities(
          extractXMLTag(
            itemXml,
            "title"
          )
        )
      );

    const description =
      cleanText(
        decodeHtmlEntities(
          extractXMLTag(
            itemXml,
            "description"
          )
        )
      );

    const link =
      cleanUrl(
        decodeHtmlEntities(
          extractXMLTag(
            itemXml,
            "link"
          )
        )
      );

    const pubDate =
      cleanText(
        extractXMLTag(
          itemXml,
          "pubDate"
        )
      );

    if (
      !title ||
      !link
    ) {
      continue;
    }

    items.push({
      title,
      description,
      link,
      pubDate,
      source,
    });
  }

  return items;
}

function extractXMLTag(
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

  return match?.[1] || "";
}

/*
 * =========================================================
 * PAGE TEXT
 * =========================================================
 */

function extractPageText(
  html: string
): string {
  let text =
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
      );

  text =
    stripHtml(
      text
    );

  text =
    decodeHtmlEntities(
      text
    );

  text =
    cleanText(
      text
    );

  return text.slice(
    0,
    MAX_SOURCE_PAGE_CHARS
  );
}

/*
 * =========================================================
 * PRIORITÉS
 * =========================================================
 */

function clusterPriority(
  cluster: FeedItem[]
): number {
  const sourceScore =
    Math.max(
      ...cluster.map(
        (item) =>
          sourcePriority(
            item.source
          )
      )
    );

  const sizeBonus =
    Math.min(
      cluster.length,
      5
    );

  const titleScore =
    cluster.reduce(
      (score, item) => {
        const normalized =
          normalizeForComparison(
            item.title
          );

        if (
          /match|composition|compose|blessure|transfert|mercato|contrat|groupe|diffusion|chaine|heure/.test(
            normalized
          )
        ) {
          return score + 2;
        }

        return score + 1;
      },
      0
    );

  return (
    sourceScore * 10 +
    sizeBonus +
    titleScore
  );
}

function sourcePriority(
  source: string
): number {
  const normalized =
    normalizeForComparison(
      source
    );

  if (
    normalized.includes(
      "culturepsg"
    )
  ) {
    return 5;
  }

  if (
    normalized.includes(
      "rmc"
    )
  ) {
    return 4;
  }

  if (
    normalized.includes(
      "equipe"
    )
  ) {
    return 4;
  }

  if (
    normalized.includes(
      "foot mercato"
    )
  ) {
    return 3;
  }

  if (
    normalized.includes(
      "google news"
    )
  ) {
    return 2;
  }

  return 1;
}

/*
 * =========================================================
 * TOKENS
 * =========================================================
 */

function meaningfulTokens(
  text: string
): string[] {
  const stopWords = new Set([
    "avec",
    "dans",
    "pour",
    "contre",
    "plus",
    "apres",
    "avant",
    "entre",
    "cette",
    "cette",
    "sont",
    "sera",
    "etre",
    "avoir",
    "fait",
    "faire",
    "mais",
    "sur",
    "une",
    "des",
    "les",
    "du",
    "de",
    "la",
    "le",
    "un",
    "et",
    "ou",
    "au",
    "aux",
    "par",
    "en",
    "ce",
    "se",
    "son",
    "sa",
    "ses",
    "leur",
    "leurs",
    "qui",
    "que",
    "est",
    "a",
    "à",
  ]);

  return normalizeForComparison(
    text
  )
    .split(/\s+/)
    .map(
      (token) =>
        token.trim()
    )
    .filter(
      (token) =>
        token.length >= 3 &&
        !stopWords.has(
          token
        )
    );
}

function titleSimilarity(
  a: string,
  b: string
): number {
  return simpleStorySimilarity(
    a,
    b
  );
}

/*
 * =========================================================
 * NORMALISATION URL / TEXTE
 * =========================================================
 */

function normalizeForComparison(
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
      /[^a-z0-9\s]/g,
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
  if (!value) {
    return "";
  }

  try {
    const url =
      new URL(
        value
      );

    url.hash = "";

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
    ];

    for (
      const parameter of trackingParams
    ) {
      url.searchParams.delete(
        parameter
      );
    }

    return url.toString();
  } catch {
    return value
      .trim()
      .replace(
        /\/$/,
        ""
      );
  }
}

function cleanUrl(
  value: string
): string {
  return value
    .trim()
    .replace(
      /^<!\[CDATA\[/,
      ""
    )
    .replace(
      /\]\]>$/,
      ""
    );
}

function cleanText(
  value: string
): string {
  return value
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function cleanArticleContent(
  value: string
): string {
  return decodeHtmlEntities(
    stripHtml(
      value
    )
  )
    .replace(
      /\r/g,
      ""
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

function stripHtml(
  value: string
): string {
  return value
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<\/p>/gi,
      "\n\n"
    )
    .replace(
      /<[^>]*>/g,
      " "
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
      /&#39;|&apos;/gi,
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

/*
 * =========================================================
 * WORD COUNT
 * =========================================================
 */

function countWords(
  value: string
): number {
  const words =
    value
      .trim()
      .split(/\s+/)
      .filter(Boolean);

  return words.length;
}

/*
 * =========================================================
 * DÉBUT DE JOURNÉE
 * =========================================================
 */

function getStartOfToday(): Date {
  const date =
    new Date();

  date.setHours(
    0,
    0,
    0,
    0
  );

  return date;
}

/*
 * =========================================================
 * SLUG UNIQUE
 * =========================================================
 */

async function makeUniqueSlug(
  title: string
): Promise<string> {
  const base =
    slugify(
      title
    ) ||
    `psg-${Date.now()}`;

  let slug =
    base;

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
      `${base}-${counter}`;

    counter++;
  }

  return slug;
}

function slugify(
  value: string
): string {
  return normalizeForComparison(
    value
  )
    .replace(
      /\s+/g,
      "-"
    )
    .replace(
      /-+/g,
      "-"
    )
    .replace(
      /^-|-$/g,
      ""
    );
}

/*
 * =========================================================
 * FETCH AVEC TIMEOUT
 * =========================================================
 */

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options?: RequestInit
): Promise<string> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          ...options,
          signal:
            controller.signal,
          cache: "no-store",
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(
      timeout
    );
  }
}

/*
 * =========================================================
 * ERREURS
 * =========================================================
 */

function getErrorMessage(
  error: unknown
): string {
  if (
    error instanceof Error
  ) {
    return error.message;
  }

  if (
    typeof error ===
    "string"
  ) {
    return error;
  }

  try {
    return JSON.stringify(
      error
    );
  } catch {
    return "Unknown error";
  }
}
