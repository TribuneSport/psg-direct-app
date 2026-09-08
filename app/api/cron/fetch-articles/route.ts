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
const GEMINI_TIMEOUT_MS = 5000;

const MIN_ARTICLE_WORDS = 400;
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

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  const secret = new URL(req.url).searchParams.get("secret");

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

  try {
    /*
     * ---------------------------------------------------------
     * 1. RÉCUPÉRATION RSS
     * ---------------------------------------------------------
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
                "User-Agent":
                  "PSG-Direct/1.0",
              },
            }
          );

          return {
            feed: feed.name,
            items: parseRSS(
              xml,
              feed.name
            ),
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
     * ---------------------------------------------------------
     * 2. FILTRAGE PSG
     * ---------------------------------------------------------
     */

    const relevantItems =
      allItems.filter(
        isRelevantPSG
      );

    /*
     * ---------------------------------------------------------
     * 3. DÉDUPLICATION RSS
     * ---------------------------------------------------------
     */

    const uniqueItems =
      deduplicateItems(
        relevantItems
      );

    /*
     * ---------------------------------------------------------
     * 4. ARTICLES DÉJÀ PRÉSENTS
     * ---------------------------------------------------------
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

    const newItems =
      uniqueItems.filter(
        (item) =>
          !isAlreadyStored(
            item,
            recentArticles
          )
      );

    /*
     * ---------------------------------------------------------
     * 5. REGROUPEMENT DES SUJETS
     * ---------------------------------------------------------
     */

    const clusters =
      buildSimpleClusters(
        newItems
      );

    const candidateClusters =
      clusters
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
     * ---------------------------------------------------------
     * 6. OBJECTIF QUOTIDIEN
     * ---------------------------------------------------------
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
     * On garde une copie en mémoire afin
     * d'éviter de créer deux fois le même
     * article pendant le même run.
     */

    const articlesForDuplicateCheck =
      [...recentArticles];

    let created = 0;
    let skipped = 0;

    /*
     * ---------------------------------------------------------
     * 7. TRAITEMENT DES CLUSTERS
     * ---------------------------------------------------------
     */

    for (
      let index = 0;
      index <
      selectedClusters.length;
      index++
    ) {
      const result =
        await processCluster(
          selectedClusters[index],
          articlesForDuplicateCheck,
          index + 1
        );

      diagnostics.push(
        result.diagnostic
      );

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

        articlesForDuplicateCheck.push(
          {
            title:
              result.articleTitle ||
              "",
            slug: "",
            sourceUrl:
              result.sourceUrl ||
              null,
          }
        );
      } else {
        skipped++;
      }
    }

    /*
     * ---------------------------------------------------------
     * 8. RÉSULTAT
     * ---------------------------------------------------------
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
 * TRAITEMENT D'UN CLUSTER
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
}> {
  const sources = [
    ...new Set(
      cluster.map(
        (item) =>
          item.source
      )
    ),
  ];

  const titles =
    cluster.map(
      (item) =>
        item.title
    );

  /*
   * Priorité aux médias les plus intéressants.
   */

  const sorted =
    [...cluster]
      .sort(
        (a, b) =>
          sourcePriority(
            b.source
          ) -
          sourcePriority(
            a.source
          )
      )
      .slice(
        0,
        MAX_SOURCES_PER_ARTICLE
      );

  /*
   * ENRICHISSEMENT AVANT GEMINI
   */

  const enrichment =
    await enrichSources(
      sorted
    );

  /*
   * GÉNÉRATION
   */

  const generation =
    await generateArticle(
      enrichment.sources
    );

  if (
    generation.ok === false
  ) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          generation.reason,

        detail:
          generation.error,
      },

      enrichment,
    };
  }

  /*
   * NORMALISATION
   */

  const article =
    normalizeArticle(
      generation.article
    );

  const words =
    countWords(
      article.content
    );

  /*
   * PROTECTION CONTRE LES ARTICLES
   * TROP COURTS
   */

  if (
    words <
    MIN_ARTICLE_WORDS
  ) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          "too_short",

        detail:
          `title=${article.title.length}, words=${words}, excerpt=${article.excerpt.length}`,
      },

      enrichment,
    };
  }

  /*
   * DOUBLE VÉRIFICATION DES DOUBLONS
   */

  const duplicate =
    recentArticles.some(
      (existing) =>
        existing.title &&
        titleSimilarity(
          article.title,
          existing.title
        ) >= 0.9
    );

  if (duplicate) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          "duplicate_after_generation",

        detail:
          article.title,
      },

      enrichment,
    };
  }

  /*
   * SLUG
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
      articleTitle: null,
      sourceUrl: null,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          "slug_error",

        detail:
          getErrorMessage(error),
      },

      enrichment,
    };
  }

  const sourceUrl =
    sorted[0]?.link ||
    null;

  /*
   * CRÉATION EN BROUILLON
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

        club:
          "PSG",

        status:
          "DRAFT",

        isAiGenerated:
          true,

        sourceUrl,
      },
    });

    return {
      created: true,

      articleTitle:
        article.title,

      sourceUrl,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          "created",

        detail:
          `words=${words}, sources=${enrichment.sources.length}, pages=${enrichment.pagesFetched}`,
      },

      enrichment,
    };
  } catch (error) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,

      diagnostic: {
        cluster:
          clusterNumber,

        sources,

        titles,

        outcome:
          "create_error",

        detail:
          getErrorMessage(error),
      },

      enrichment,
    };
  }
}

/*
 * =========================================================
 * ENRICHISSEMENT DES SOURCES
 * =========================================================
 */

async function enrichSources(
  items: FeedItem[]
): Promise<EnrichmentResult> {
  let pagesFetched = 0;
  let pagesFailed = 0;
  let enrichedCharacters = 0;

  const pageErrors: string[] = [];

  const sources =
    await Promise.all(
      items.map(
        async (item) => {
          let description =
            cleanText(
              item.description
            );

          /*
           * On tente maintenant beaucoup plus souvent
           * de récupérer la page originale.
           */

          const needsPage =
            shouldFetchSourcePage(
              item,
              description,
              items
            );

          if (!needsPage) {
            return {
              title:
                item.title,

              description,

              source:
                item.source,

              link:
                item.link,
            };
          }

          try {
            const page =
              await fetchWithTimeout(
                item.link,
                SOURCE_TIMEOUT_MS,
                {
                  headers: {
                    Accept:
                      "text/html,application/xhtml+xml",

                    "User-Agent":
                      "Mozilla/5.0 (compatible; PSG-Direct/1.0; +https://psg-direct-app.vercel.app)",
                  },
                }
              );

            const extracted =
              extractPageText(
                page
              );

            pagesFetched++;

            /*
             * On ne remplace la description
             * que si la page contient réellement
             * davantage d'informations.
             */

            if (
              extracted.length >
              description.length +
                80
            ) {
              const before =
                description.length;

              description =
                extracted.slice(
                  0,
                  MAX_SOURCE_PAGE_CHARS
                );

              enrichedCharacters +=
                Math.max(
                  0,
                  description.length -
                    before
                );
            }
          } catch (error) {
            pagesFailed++;

            const message =
              getErrorMessage(
                error
              );

            pageErrors.push(
              `${item.source}: ${message}`
            );
          }

          return {
            title:
              item.title,

            description,

            source:
              item.source,

            link:
              item.link,
          };
        }
      )
    );

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
 * DÉCISION D'ENRICHISSEMENT
 * =========================================================
 */

function shouldFetchSourcePage(
  item: FeedItem,
  description: string,
  cluster: FeedItem[]
): boolean {
  const words =
    countWords(
      description
    );

  const title =
    normalizeForComparison(
      item.title
    );

  /*
   * Les sujets nécessitant souvent
   * des informations précises.
   */

  const concreteIntent =
    /\b(heure|quelle chaine|quelle chaîne|chaine tv|chaîne tv|composition|compo|absent|absence|blesse|blessé|blessure|forfait|transfert|mercato|contrat|prolongation|arbitre|stade|diffusion|direct|ballon d'or)\b/i.test(
      title
    );

  /*
   * Plusieurs médias parlent du même sujet :
   * on cherche alors à fusionner les informations.
   */

  const repeatedSubject =
    cluster.length > 1;

  /*
   * RMC / CulturePSG sont prioritaires.
   */

  const highPriority =
    sourcePriority(
      item.source
    ) >= 4;

  /*
   * Description courte.
   */

  const lowInformation =
    words <
    LOW_INFORMATION_WORDS;

  /*
   * Certaines descriptions RSS
   * sont en réalité uniquement des teasers.
   */

  const suspiciousDescription =
    description.length <
      500 ||
    /\b(lire la suite|cliquez|retrouvez|plus d'informations|article complet|en savoir plus)\b/i.test(
      description
    );

  return (
    lowInformation ||
    repeatedSubject ||
    concreteIntent ||
    highPriority ||
    suspiciousDescription
  );
}

/*
 * =========================================================
 * GEMINI
 * =========================================================
 */

async function generateArticle(
  sources: ArticleInput[]
): Promise<
  | {
      ok: true;
      article: GeminiArticle;
    }
  | {
      ok: false;
      reason: string;
      error: string;
    }
> {
  const sourceText =
    sources
      .map(
        (
          source,
          index
        ) =>
          [
            `SOURCE ${index + 1}`,

            `Média : ${source.source}`,

            `Titre : ${source.title}`,

            `Informations : ${source.description}`,

            `Lien : ${source.link}`,
          ].join("\n")
      )
      .join(
        "\n\n"
      );

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Transforme les informations fournies ci-dessous en UN seul article original de presse sportive consacré au Paris Saint-Germain.

RÈGLES ABSOLUES :

- Utilise uniquement les informations présentes dans les sources.
- N'invente aucune information.
- N'invente aucune date.
- N'invente aucune heure.
- N'invente aucun stade.
- N'invente aucune chaîne TV.
- N'invente aucune plateforme de diffusion.
- N'invente aucun joueur.
- N'invente aucun transfert.
- N'invente aucun résultat.
- N'invente aucune déclaration.
- N'invente aucun classement.
- Si une information n'est pas présente dans les sources, ne l'affirme pas.
- Fusionne les sources uniquement lorsqu'elles concernent exactement le même sujet.
- Ne mélange jamais deux matchs différents.
- Ne mélange jamais deux transferts différents.
- Ne mélange jamais deux joueurs différents.
- Ne mentionne pas l'intelligence artificielle.
- Ne copie pas les phrases originales.
- Rédige dans un français naturel et journalistique.
- Donne la priorité aux informations factuelles et vérifiables.
- Une information présente dans plusieurs sources est particulièrement solide.
- Une information présente dans une seule source peut être utilisée si elle est clairement attribuable à cette source.
- Ne transforme jamais une hypothèse en certitude.
- Si les sources ne donnent pas une information, ne la complète pas avec tes connaissances générales.

INFORMATIONS FACTUELLES À PRIVILÉGIER :

- date du match
- heure du match
- compétition
- journée
- adversaire
- stade
- chaîne de télévision
- plateforme de diffusion
- compositions probables
- absents
- blessés
- suspendus
- arbitre
- conférence de presse
- déclarations
- contexte sportif
- classement
- forme récente
- mercato
- transferts
- contrats
- prolongations

IMPORTANT :

Si plusieurs sources parlent du même événement, fusionne leurs informations afin de produire un article plus complet.

Exemple :

SOURCE 1 :
Le match aura lieu à 21h.

SOURCE 2 :
Le match sera diffusé sur Canal+.

SOURCE 3 :
Le match aura lieu au Parc des Princes.

L'article final doit donc contenir ces trois informations.

Mais si une information n'est présente dans aucune source, ne l'invente jamais.

STRUCTURE OBLIGATOIRE :

- Un titre précis et informatif.
- Un chapô de 2 à 3 phrases.
- Une introduction factuelle.
- 3 à 5 intertitres Markdown commençant par ##.
- Des paragraphes courts.
- Une conclusion.

Le titre doit être précis et correspondre exactement au sujet.

Évite les titres vagues comme :

"PSG - Monaco : les détails à suivre"

Privilégie un titre informatif lorsque les données disponibles le permettent.

LONGUEUR :

Entre 500 et 800 mots lorsque les informations disponibles le permettent.

Si les sources ne permettent pas d'atteindre 500 mots sans inventer, écris moins long plutôt que d'inventer.

FORMAT JSON STRICT :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}

Le champ content doit être du Markdown.

Conserve de vrais retours à la ligne entre les paragraphes.

SOURCES :

${sourceText}
`;

  const response =
    await callGemini(
      prompt
    );

  if (
    response.ok === false
  ) {
    return {
      ok: false,
      reason:
        "generation_error",
      error:
        response.error,
    };
  }

  const parsed =
    parseGeminiJson(
      response.text
    );

  if (!parsed) {
    return {
      ok: false,
      reason:
        "invalid_json",
      error:
        "Gemini response is not valid JSON",
    };
  }

  if (
    !parsed.title ||
    !parsed.excerpt ||
    !parsed.content
  ) {
    return {
      ok: false,
      reason:
        "invalid_json",
      error:
        "Missing title, excerpt or content",
    };
  }

  return {
    ok: true,

    article: {
      title:
        cleanText(
          parsed.title
        ),

      excerpt:
        cleanText(
          parsed.excerpt
        ),

      content:
        cleanArticleContent(
          parsed.content
        ),
    },
  };
}

/*
 * =========================================================
 * APPEL GEMINI
 * =========================================================
 */

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
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ];

  const errors: string[] = [];

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

      try {
        const response =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
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
                      parts: [
                        {
                          text: prompt,
                        },
                      ],
                    },
                  ],

                  generationConfig: {
                    temperature:
                      0.2,

                    maxOutputTokens:
                      2200,

                    responseMimeType:
                      "application/json",
                  },
                }),

              signal:
                controller.signal,

              cache:
                "no-store",
            }
          );

        if (
          !response.ok
        ) {
          const body =
            await response.text();

          errors.push(
            `Gemini ${model}: HTTP ${response.status}${
              body
                ? ` - ${body.slice(
                    0,
                    250
                  )}`
                : ""
            }`
          );

          continue;
        }

        const json =
          await response.json();

        const text =
          json
            ?.candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;

        if (
          typeof text !==
            "string" ||
          !text.trim()
        ) {
          errors.push(
            `Gemini ${model}: empty response`
          );

          continue;
        }

        return {
          ok: true,
          text,
        };
      } finally {
        clearTimeout(
          timeout
        );
      }
    } catch (error) {
      errors.push(
        `Gemini ${model}: ${getErrorMessage(
          error
        )}`
      );
    }
  }

  return {
    ok: false,

    error:
      errors.join(
        " | "
      ) ||
      "Gemini request failed",
  };
}

/*
 * =========================================================
 * JSON GEMINI
 * =========================================================
 */

function parseGeminiJson(
  text: string
): GeminiArticle | null {
  try {
    let cleaned =
      text.trim();

    cleaned =
      cleaned.replace(
        /^```json/gi,
        ""
      );

    cleaned =
      cleaned.replace(
        /^```/gi,
        ""
      );

    cleaned =
      cleaned.replace(
        /```$/gi,
        ""
      );

    cleaned =
      cleaned.trim();

    const parsed =
      JSON.parse(
        cleaned
      );

    if (
      typeof parsed?.title !==
        "string" ||
      typeof parsed?.excerpt !==
        "string" ||
      typeof parsed?.content !==
        "string"
    ) {
      return null;
    }

    return {
      title:
        parsed.title,

      excerpt:
        parsed.excerpt,

      content:
        parsed.content,
    };
  } catch {
    return null;
  }
}

/*
 * =========================================================
 * NORMALISATION ARTICLE
 * =========================================================
 */

function normalizeArticle(
  article: GeminiArticle
): GeminiArticle {
  let content =
    cleanArticleContent(
      article.content
    );

  if (
    !content.match(
      /^## .+$/gm
    )
  ) {
    content =
      addBasicStructure(
        content
      );
  }

  const words =
    countWords(
      content
    );

  if (
    words >
    MAX_ARTICLE_WORDS
  ) {
    content =
      trimToWords(
        content,
        MAX_ARTICLE_WORDS
      );
  }

  return {
    title:
      cleanText(
        article.title
      ),

    excerpt:
      cleanText(
        article.excerpt
      ),

    content:
      content.trim(),
  };
}

/*
 * =========================================================
 * STRUCTURE DE SECOURS
 * =========================================================
 */

function addBasicStructure(
  content: string
): string {
  const paragraphs =
    content
      .split(
        /\n\s*\n/
      )
      .map(
        (paragraph) =>
          paragraph.trim()
      )
      .filter(Boolean);

  if (
    paragraphs.length <
    4
  ) {
    return content;
  }

  const result: string[] =
    [
      paragraphs[0],
    ];

  const remaining =
    paragraphs.slice(
      1
    );

  for (
    let index = 0;
    index <
    remaining.length;
    index++
  ) {
    if (
      index === 0
    ) {
      result.push(
        "## Les faits"
      );
    } else if (
      index === 1
    ) {
      result.push(
        "## Les informations importantes"
      );
    } else if (
      index === 2
    ) {
      result.push(
        "## La suite"
      );
    }

    result.push(
      remaining[index]
    );
  }

  return result.join(
    "\n\n"
  );
}

/*
 * =========================================================
 * LIMITATION MOTS
 * =========================================================
 */

function trimToWords(
  text: string,
  maxWords: number
): string {
  const words =
    text
      .split(
        /\s+/
      )
      .filter(Boolean);

  if (
    words.length <=
    maxWords
  ) {
    return text;
  }

  return `${words
    .slice(
      0,
      maxWords
    )
    .join(
      " "
    )}...`;
}

/*
 * =========================================================
 * CLUSTERS
 * =========================================================
 */

function buildSimpleClusters(
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
        0.72
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

function similarityToCluster(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  const itemOpponent =
    extractOpponent(
      normalizeForComparison(
        item.title
      )
    );

  const clusterOpponents =
    [
      ...new Set(
        cluster
          .map(
            (entry) =>
              extractOpponent(
                normalizeForComparison(
                  entry.title
                )
              )
          )
          .filter(
            (
              opponent
            ): opponent is string =>
              Boolean(
                opponent
              )
          )
      ),
    ];

  if (
    itemOpponent &&
    clusterOpponents.length >
      0 &&
    !clusterOpponents.includes(
      itemOpponent
    )
  ) {
    return 0;
  }

  if (
    !itemOpponent &&
    clusterOpponents.length >
      0
  ) {
    const bestTitleScore =
      Math.max(
        ...cluster.map(
          (other) =>
            titleSimilarity(
              item.title,
              other.title
            )
        )
      );

    if (
      bestTitleScore <
      0.88
    ) {
      return 0;
    }
  }

  let best = 0;

  for (
    const other of cluster
  ) {
    best =
      Math.max(
        best,
        simpleStorySimilarity(
          item,
          other
        )
      );
  }

  return best;
}

function simpleStorySimilarity(
  a: FeedItem,
  b: FeedItem
): number {
  const titleA =
    normalizeForComparison(
      a.title
    );

  const titleB =
    normalizeForComparison(
      b.title
    );

  const opponentA =
    extractOpponent(
      titleA
    );

  const opponentB =
    extractOpponent(
      titleB
    );

  if (
    opponentA &&
    opponentB &&
    opponentA !==
      opponentB
  ) {
    return 0;
  }

  const eventA =
    extractEvent(
      titleA
    );

  const eventB =
    extractEvent(
      titleB
    );

  const similarity =
    titleSimilarity(
      a.title,
      b.title
    );

  if (
    similarity >=
    0.88
  ) {
    return similarity;
  }

  const tokensA =
    meaningfulTokens(
      titleA
    );

  const tokensB =
    meaningfulTokens(
      titleB
    );

  if (
    tokensA.length ===
      0 ||
    tokensB.length ===
      0
  ) {
    return 0;
  }

  const common =
    tokensA.filter(
      (token) =>
        tokensB.includes(
          token
        )
    );

  const overlap =
    common.length /
    Math.max(
      1,
      Math.min(
        tokensA.length,
        tokensB.length
      )
    );

  if (
    opponentA &&
    opponentB &&
    opponentA ===
      opponentB
  ) {
    return Math.max(
      0.76,
      overlap
    );
  }

  if (
    eventA &&
    eventB &&
    eventA ===
      eventB &&
    overlap >=
      0.6
  ) {
    return Math.max(
      0.68,
      overlap
    );
  }

  return overlap >=
    0.75
    ? overlap
    : 0;
}

/*
 * =========================================================
 * ADVERSAIRES
 * =========================================================
 */

function extractOpponent(
  title: string
): string | null {
  const opponents = [
    "slovan bratislava",
    "bratislava",
    "slovan",
    "monaco",
    "lille",
    "marseille",
    "lyon",
    "lens",
    "rennes",
    "nice",
    "auxerre",
    "nantes",
    "strasbourg",
    "brest",
    "toulouse",
    "angers",
    "le havre",
    "lorient",
    "le mans",
    "metz",
    "reims",
    "montpellier",
    "saint-etienne",
    "saint etienne",
    "bordeaux",
    "nimes",
    "real madrid",
    "barcelone",
    "barcelona",
    "bayern",
    "liverpool",
    "arsenal",
    "manchester city",
    "manchester united",
    "juventus",
    "milan",
    "inter",
    "chelsea",
    "tottenham",
    "newcastle",
    "west ham",
    "brighton",
    "aston villa",
  ];

  return (
    opponents.find(
      (opponent) =>
        title.includes(
          opponent
        )
    ) ||
    null
  );
}

/*
 * =========================================================
 * TYPE D'ÉVÉNEMENT
 * =========================================================
 */

function extractEvent(
  title: string
): string | null {
  const events = [
    "composition",
    "compo",
    "compositions",
    "equipe type",
    "formation",
    "match",
    "blessure",
    "blesse",
    "blessé",
    "absence",
    "absent",
    "mercato",
    "transfert",
    "transferts",
    "recrutement",
    "signature",
    "prolongation",
    "contrat",
    "depart",
    "départ",
    "arrivee",
    "arrivée",
    "ballon d'or",
    "ballon dor",
    "interview",
    "declaration",
    "déclaration",
    "declarations",
    "déclarations",
    "conference",
    "conférence",
    "conférence de presse",
  ];

  return (
    events.find(
      (event) =>
        title.includes(
          event
        )
    ) ||
    null
  );
}

/*
 * =========================================================
 * DÉDUPLICATION RSS
 * =========================================================
 */

function deduplicateItems(
  items: FeedItem[]
): FeedItem[] {
  const result: FeedItem[] =
    [];

  const urls =
    new Set<string>();

  const titles =
    new Set<string>();

  for (
    const item of items
  ) {
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
      urls.has(url)
    ) {
      continue;
    }

    if (
      title &&
      titles.has(title)
    ) {
      continue;
    }

    if (url) {
      urls.add(url);
    }

    if (title) {
      titles.add(title);
    }

    result.push(
      item
    );
  }

  return result;
}

/*
 * =========================================================
 * ARTICLE DÉJÀ STOCKÉ
 * =========================================================
 */

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

  if (
    itemUrl &&
    articles.some(
      (article) =>
        normalizeUrl(
          article.sourceUrl ||
            ""
        ) ===
        itemUrl
    )
  ) {
    return true;
  }

  return articles.some(
    (article) =>
      titleSimilarity(
        item.title,
        article.title
      ) >= 0.9
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
    normalizeForComparison(
      `${item.title} ${item.description}`
    );

  return (
    text.includes(
      "psg"
    ) ||
    text.includes(
      "paris saint-germain"
    ) ||
    text.includes(
      "paris saint germain"
    ) ||
    text.includes(
      "paris sg"
    )
  );
}

/*
 * =========================================================
 * RSS PARSER
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
    );

  if (
    !itemMatches
  ) {
    return items;
  }

  for (
    let index = 0;
    index <
      itemMatches.length &&
    index <
      MAX_ITEMS_PER_SOURCE;
    index++
  ) {
    const item =
      itemMatches[index];

    const title =
      decodeHtmlEntities(
        extractXMLTag(
          item,
          "title"
        )
      );

    const description =
      decodeHtmlEntities(
        extractXMLTag(
          item,
          "description"
        )
      );

    const link =
      extractXMLTag(
        item,
        "link"
      );

    const pubDate =
      extractXMLTag(
        item,
        "pubDate"
      ) ||
      extractXMLTag(
        item,
        "published"
      ) ||
      extractXMLTag(
        item,
        "date"
      );

    if (
      !title ||
      !link
    ) {
      continue;
    }

    items.push({
      title:
        cleanText(
          title
        ),

      description:
        cleanText(
          description
        ),

      link:
        cleanUrl(
          link
        ),

      pubDate,

      source,
    });
  }

  return items;
}

/*
 * =========================================================
 * EXTRACTION XML
 * =========================================================
 */

function extractXMLTag(
  xml: string,
  tag: string
): string {
  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  return (
    xml.match(
      regex
    )?.[1] ||
    ""
  );
}

/*
 * =========================================================
 * EXTRACTION PAGE WEB
 * =========================================================
 */

function extractPageText(
  html: string
): string {
  let text =
    html;

  /*
   * Suppression des éléments inutiles.
   */

  text =
    text.replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    );

  text =
    text.replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    );

  text =
    text.replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " "
    );

  text =
    text.replace(
      /<nav[\s\S]*?<\/nav>/gi,
      " "
    );

  text =
    text.replace(
      /<footer[\s\S]*?<\/footer>/gi,
      " "
    );

  text =
    text.replace(
      /<header[\s\S]*?<\/header>/gi,
      " "
    );

  text =
    text.replace(
      /<aside[\s\S]*?<\/aside>/gi,
      " "
    );

  /*
   * Priorité au contenu <article>.
   */

  const articleMatch =
    text.match(
      /<article[^>]*>([\s\S]*?)<\/article>/i
    );

  if (
    articleMatch
  ) {
    text =
      articleMatch[1];
  }

  /*
   * Conservation des paragraphes.
   */

  text =
    text.replace(
      /<br\s*\/?>/gi,
      "\n"
    );

  text =
    text.replace(
      /<\/p>/gi,
      "\n\n"
    );

  text =
    text.replace(
      /<\/h[1-6]>/gi,
      "\n\n"
    );

  text =
    text.replace(
      /<li[^>]*>/gi,
      "\n- "
    );

  text =
    text.replace(
      /<\/li>/gi,
      "\n"
    );

  return cleanArticleContent(
    decodeHtmlEntities(
      stripHtml(
        text
      )
    )
  ).slice(
    0,
    MAX_SOURCE_PAGE_CHARS
  );
}

/*
 * =========================================================
 * PRIORITÉ CLUSTER
 * =========================================================
 */

function clusterPriority(
  cluster: FeedItem[]
): number {
  let score = 0;

  for (
    const item of cluster
  ) {
    score +=
      sourcePriority(
        item.source
      );

    if (
      item.pubDate
    ) {
      const timestamp =
        Date.parse(
          item.pubDate
        );

      if (
        !Number.isNaN(
          timestamp
        )
      ) {
        score +=
          Math.max(
            0,
            10 -
              Math.floor(
                (Date.now() -
                  timestamp) /
                  3600000
              )
          );
      }
    }
  }

  score +=
    Math.min(
      cluster.length *
        5,
      20
    );

  return score;
}

/*
 * =========================================================
 * PRIORITÉ SOURCE
 * =========================================================
 */

function sourcePriority(
  source: string
): number {
  switch (
    source
  ) {
    case "RMC Sport":
      return 4;

    case "CulturePSG":
      return 4;

    case "Foot Mercato":
      return 3;

    case "Google News":
      return 2;

    default:
      return 1;
  }
}

/*
 * =========================================================
 * TOKENS
 * =========================================================
 */

function meaningfulTokens(
  text: string
): string[] {
  const ignored =
    new Set([
      "psg",
      "paris",
      "saint",
      "germain",
      "football",
      "foot",
      "club",
      "avec",
      "pour",
      "dans",
      "sur",
      "les",
      "des",
      "une",
      "un",
      "du",
      "de",
      "la",
      "le",
      "et",
      "est",
      "son",
      "ses",
      "plus",
      "apres",
      "avant",
      "cette",
      "match",
      "news",
      "direct",
    ]);

  return text
    .split(
      /\s+/
    )
    .map(
      (token) =>
        token
          .replace(
            /[^a-z0-9àâäçéèêëîïôöùûü-]/gi,
            ""
          )
          .trim()
    )
    .filter(
      (token) =>
        token.length >=
          4 &&
        !ignored.has(
          token
        )
    );
}

/*
 * =========================================================
 * SIMILARITÉ TITRES
 * =========================================================
 */

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

  let common = 0;

  for (
    const token of tokensA
  ) {
    if (
      tokensB.has(
        token
      )
    ) {
      common++;
    }
  }

  return (
    common /
    Math.max(
      1,
      Math.max(
        tokensA.size,
        tokensB.size
      )
    )
  );
}

/*
 * =========================================================
 * NORMALISATION COMPARAISON
 * =========================================================
 */

function normalizeForComparison(
  text: string
): string {
  return decodeHtmlEntities(
    text
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
      /[^a-z0-9\s-]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

/*
 * =========================================================
 * NORMALISATION URL
 * =========================================================
 */

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

    for (
      const parameter of [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
      ]
    ) {
      parsed.searchParams.delete(
        parameter
      );
    }

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

/*
 * =========================================================
 * URL PROPRE
 * =========================================================
 */

function cleanUrl(
  url: string
): string {
  return decodeHtmlEntities(
    url
  )
    .replace(
      /<!\[CDATA\[/gi,
      ""
    )
    .replace(
      /\]\]>/g,
      ""
    )
    .trim();
}

/*
 * =========================================================
 * TEXTE PROPRE
 * =========================================================
 */

function cleanText(
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

/*
 * =========================================================
 * CONTENU ARTICLE PROPRE
 * =========================================================
 */

function cleanArticleContent(
  text: string
): string {
  return decodeHtmlEntities(
    stripHtml(
      text
    )
  )
    .replace(
      /\r\n/g,
      "\n"
    )
    .replace(
      /\r/g,
      "\n"
    )
    .replace(
      /[ \t]+/g,
      " "
    )
    .replace(
      /\n[ \t]+/g,
      "\n"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

/*
 * =========================================================
 * SUPPRESSION HTML
 * =========================================================
 */

function stripHtml(
  text: string
): string {
  return text.replace(
    /<[^>]*>/g,
    " "
  );
}

/*
 * =========================================================
 * ENTITÉS HTML
 * =========================================================
 */

function decodeHtmlEntities(
  text: string
): string {
  return text
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
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&#(\d+);/g,
      (
        _,
        code
      ) =>
        String.fromCharCode(
          Number(
            code
          )
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (
        _,
        code
      ) =>
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
 * COMPTEUR MOTS
 * =========================================================
 */

function countWords(
  text: string
): number {
  const trimmed =
    text.trim();

  if (
    !trimmed
  ) {
    return 0;
  }

  return trimmed
    .split(
      /\s+/
    )
    .filter(
      Boolean
    )
    .length;
}

/*
 * =========================================================
 * DÉBUT JOURNÉE
 * =========================================================
 */

function getStartOfToday(): Date {
  const now =
    new Date();

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
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
    );

  let slug =
    base ||
    `article-${Date.now()}`;

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
    `${base}-${Date.now()}`;

  return slug;
}

/*
 * =========================================================
 * SLUGIFY
 * =========================================================
 */

function slugify(
  text: string
): string {
  return normalizeForComparison(
    text
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
      90
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
  options: RequestInit
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

          cache:
            "no-store",
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
 * MESSAGE ERREUR
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

  return String(
    error
  );
}
