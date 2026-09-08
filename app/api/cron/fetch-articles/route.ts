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
     * =========================================================
     * 1. RSS
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
            error:
              getErrorMessage(
                error
              ),
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

    const allItems =
      feeds.flatMap(
        (result) =>
          result.items
      );

    /*
     * =========================================================
     * 2. FILTRE PSG
     * =========================================================
     */

    const relevantItems =
      allItems.filter(
        isRelevantPSG
      );

    /*
     * =========================================================
     * 3. DEDUPLICATION RSS
     * =========================================================
     */

    const uniqueItems =
      deduplicateItems(
        relevantItems
      );

    /*
     * =========================================================
     * 4. ARTICLES EXISTANTS
     * =========================================================
     */

    const recentArticles =
      await prisma.article.findMany(
        {
          orderBy: {
            createdAt:
              "desc",
          },

          take: 150,

          select: {
            title: true,
            slug: true,
            sourceUrl: true,
          },
        }
      );

    const newItems =
      uniqueItems.filter(
        (item) =>
          !isAlreadyStored(
            item,
            recentArticles
          )
      );

    /*
     * =========================================================
     * 5. CLUSTERS
     * =========================================================
     */

    const clusters =
      buildSimpleClusters(
        newItems
      );

    const candidateClusters =
      clusters
        .filter(
          (cluster) =>
            cluster.length >
            0
        )
        .sort(
          (a, b) =>
            clusterPriority(
              b
            ) -
            clusterPriority(
              a
            )
        );

    /*
     * =========================================================
     * 6. OBJECTIF QUOTIDIEN
     * =========================================================
     */

    const startOfToday =
      getStartOfToday();

    const articlesCreatedToday =
      await prisma.article.count(
        {
          where: {
            club: "PSG",

            isAiGenerated:
              true,

            createdAt: {
              gte:
                startOfToday,
            },
          },
        }
      );

    const remainingDailyTarget =
      Math.max(
        0,
        DAILY_TARGET -
          articlesCreatedToday
      );

    const requestedCount =
      remainingDailyTarget >
      0
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

    const articlesForDuplicateCheck =
      [
        ...recentArticles,
      ];

    let created = 0;
    let skipped = 0;

    /*
     * =========================================================
     * 7. TRAITEMENT
     * =========================================================
     */

    for (
      let index = 0;
      index <
      selectedClusters.length;
      index++
    ) {
      const result =
        await processCluster(
          selectedClusters[
            index
          ],
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

      if (
        result.created
      ) {
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
              [
                "created",
                "too_short",
                "invalid_json",
                "generation_error",
              ].includes(
                item.outcome
              )
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
          getErrorMessage(
            error
          ),

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
   * Enrichissement des pages originales.
   */

  const enrichment =
    await enrichSources(
      sorted
    );

  /*
   * Génération Gemini.
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

  const article =
    normalizeArticle(
      generation.article
    );

  const words =
    countWords(
      article.content
    );

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
   * Protection contre les doublons après génération.
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

  if (
    duplicate
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
          "duplicate_after_generation",

        detail:
          article.title,
      },

      enrichment,
    };
  }

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
          getErrorMessage(
            error
          ),
      },

      enrichment,
    };
  }

  const sourceUrl =
    sorted[0]?.link ||
    null;

  try {
    await prisma.article.create(
      {
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
      }
    );

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
          `words=${words}, sources=${enrichment.sources.length}, pages=${enrichment.pagesFetched}, enriched=${enrichment.enrichedCharacters}`,
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
          getErrorMessage(
            error
          ),
      },

      enrichment,
    };
  }
}

/*
 * =========================================================
 * ENRICHISSEMENT
 * =========================================================
 */

async function enrichSources(
  items: FeedItem[]
): Promise<EnrichmentResult> {
  let pagesFetched = 0;
  let pagesFailed = 0;
  let enrichedCharacters = 0;

  const pageErrors: string[] =
    [];

  const sources =
    await Promise.all(
      items.map(
        async (item) => {
          let description =
            cleanText(
              item.description
            );

          const needsPage =
            shouldFetchSourcePage(
              item,
              description,
              items
            );

          if (
            !needsPage
          ) {
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

            pageErrors.push(
              `${item.source}: ${getErrorMessage(
                error
              )}`
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
 * DÉCISION ENRICHISSEMENT
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

  const concreteIntent =
    /\b(heure|quelle chaine|quelle chaîne|chaine tv|chaîne tv|composition|compo|compositions|blessure|blesse|blessé|forfait|transfert|transferts|mercato|contrat|prolongation|arbitre|stade|diffusion|direct|ballon d'or|ballon dor|absent|absents|absence)\b/i.test(
      title
    );

  const repeatedSubject =
    cluster.length >
    1;

  const highPriority =
    sourcePriority(
      item.source
    ) >= 4;

  const lowInformation =
    words <
    LOW_INFORMATION_WORDS;

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

            `URL : ${source.link}`,
          ].join("\n")
      )
      .join(
        "\n\n==============================\n\n"
      );

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Ta mission est de transformer les sources ci-dessous en UN SEUL article original de presse sportive sur le Paris Saint-Germain.

OBJECTIF :

Produire un article factuel, précis, utile au lecteur et beaucoup plus riche que les simples titres RSS.

IMPORTANT :

Plusieurs sources peuvent parler exactement du même événement.

Tu dois FUSIONNER ces sources.

Exemple :

Source A :
Le PSG joue samedi à 21h.

Source B :
Le match est diffusé sur Canal+.

Source C :
Le match se joue au Parc des Princes.

Tu dois produire UN article contenant les trois informations.

Tu ne dois surtout pas produire trois articles différents.

RÈGLES ABSOLUES :

1. Utilise uniquement les informations contenues dans les sources.

2. N'invente absolument aucune information.

3. Si une information n'est pas présente dans les sources, ne la crée pas.

4. Ne complète jamais avec tes connaissances personnelles.

5. Ne devine jamais une heure.

6. Ne devine jamais une date.

7. Ne devine jamais un stade.

8. Ne devine jamais une chaîne TV.

9. Ne devine jamais une plateforme de streaming.

10. Ne devine jamais une composition.

11. Ne devine jamais une absence.

12. Ne devine jamais une blessure.

13. Ne devine jamais un résultat.

14. Ne devine jamais une déclaration.

15. Ne devine jamais un classement.

16. Ne mélange jamais deux événements différents.

17. Ne mélange jamais deux matchs différents.

18. Ne mélange jamais deux joueurs différents.

19. Ne mélange jamais deux transferts différents.

20. Si deux sources parlent du même sujet, fusionne leurs informations.

21. Une information présente dans plusieurs sources est particulièrement fiable.

22. Une information provenant d'une seule source peut être utilisée si elle est clairement présentée dans cette source.

23. Si une information est incertaine, présente-la comme telle.

24. Ne mentionne jamais Gemini.

25. Ne mentionne jamais l'IA.

26. Ne copie jamais les phrases originales.

27. Réécris entièrement l'information avec ton propre style journalistique.

28. Le français doit être naturel.

29. Évite les phrases génériques.

30. Chaque paragraphe doit apporter une information utile.

INFORMATIONS À RECHERCHER DANS LES SOURCES :

- date du match
- heure
- adversaire
- compétition
- journée
- stade
- diffusion TV
- streaming
- compositions
- absents
- blessés
- suspendus
- arbitre
- conférence de presse
- déclarations
- contexte
- forme récente
- classement
- mercato
- transfert
- contrat
- prolongation
- entraînement
- actualité du groupe

IMPORTANT POUR LES INFORMATIONS MANQUANTES :

Si les sources indiquent :

"Le match aura lieu samedi"

mais ne donnent aucune heure :

écris simplement que le match est prévu samedi.

N'invente pas l'heure.

Si les sources indiquent :

"Le match sera diffusé à la télévision"

mais ne donnent pas la chaîne :

ne donne aucune chaîne.

Si les sources donnent une information précise :

conserve cette précision.

OBJECTIF DE LONGUEUR :

Essaie de produire entre 500 et 800 mots lorsque les informations disponibles le permettent.

Cependant :

Il est préférable de produire 350 mots factuels plutôt que 600 mots inventés.

STRUCTURE :

Titre :

Un titre précis, informatif et journalistique.

Chapô :

2 ou 3 phrases résumant les informations principales.

Corps :

## Un premier intertitre informatif

Paragraphes courts.

## Deuxième intertitre informatif

Paragraphes courts.

## Troisième intertitre informatif

Paragraphes courts.

## Les dernières informations

Paragraphes courts.

Conclusion :

Une courte conclusion utile.

ÉVITE ABSOLUMENT les titres vagues comme :

"PSG - Monaco : les détails à suivre"

"Le PSG prépare son prochain match"

"Une nouvelle importante pour le PSG"

Le titre doit dire précisément ce qui est nouveau.

FORMAT DE SORTIE :

Retourne UNIQUEMENT un objet JSON valide.

AUCUN texte avant le JSON.

AUCUN texte après le JSON.

AUCUNE balise Markdown autour du JSON.

Format exact :

{
  "title": "Titre de l'article",
  "excerpt": "Chapô de l'article",
  "content": "Contenu complet en Markdown"
}

Le contenu peut contenir :

## Intertitre

Paragraphes.

Conserve les retours à la ligne.

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

  const errors: string[] =
    [];

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
                      3000,

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
 * PARSING JSON ROBUSTE
 * =========================================================
 */

function parseGeminiJson(
  text: string
): GeminiArticle | null {
  if (
    !text ||
    !text.trim()
  ) {
    return null;
  }

  let cleaned =
    text.trim();

  /*
   * Suppression des balises Markdown.
   */

  cleaned =
    cleaned.replace(
      /^\uFEFF/,
      ""
    );

  cleaned =
    cleaned.replace(
      /^```(?:json)?\s*/i,
      ""
    );

  cleaned =
    cleaned.replace(
      /\s*```$/i,
      ""
    );

  cleaned =
    cleaned.trim();

  /*
   * Premier essai :
   * JSON complet.
   */

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
      return {
        title:
          parsed.title,

        excerpt:
          parsed.excerpt,

        content:
          parsed.content,
      };
    }
  } catch {
    /*
     * On continue avec
     * l'extraction du JSON.
     */
  }

  /*
   * Gemini peut parfois répondre :
   *
   * Voici le JSON :
   * {
   *   ...
   * }
   *
   * On récupère alors le premier
   * objet JSON équilibré.
   */

  const jsonCandidate =
    extractFirstJsonObject(
      cleaned
    );

  if (
    !jsonCandidate
  ) {
    return null;
  }

  try {
    const parsed =
      JSON.parse(
        jsonCandidate
      );

    if (
      !isValidGeminiArticle(
        parsed
      )
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
    /*
     * Dernier niveau :
     * tentative de nettoyage
     * des caractères problématiques.
     */

    try {
      const repaired =
        repairJsonString(
          jsonCandidate
        );

      const parsed =
        JSON.parse(
          repaired
        );

      if (
        !isValidGeminiArticle(
          parsed
        )
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
}

/*
 * =========================================================
 * VALIDATION OBJET GEMINI
 * =========================================================
 */

function isValidGeminiArticle(
  value: unknown
): value is GeminiArticle {
  if (
    typeof value !==
    "object" ||
    value === null
  ) {
    return false;
  }

  const object =
    value as Record<
      string,
      unknown
    >;

  return (
    typeof object.title ===
      "string" &&
    typeof object.excerpt ===
      "string" &&
    typeof object.content ===
      "string"
  );
}

/*
 * =========================================================
 * EXTRACTION OBJET JSON
 * =========================================================
 */

function extractFirstJsonObject(
  text: string
): string | null {
  const start =
    text.indexOf(
      "{"
    );

  if (
    start === -1
  ) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (
    let index = start;
    index <
    text.length;
    index++
  ) {
    const character =
      text[index];

    if (
      inString
    ) {
      if (
        escaped
      ) {
        escaped =
          false;
        continue;
      }

      if (
        character ===
        "\\"
      ) {
        escaped =
          true;
        continue;
      }

      if (
        character ===
        '"'
      ) {
        inString =
          false;
      }

      continue;
    }

    if (
      character ===
      '"'
    ) {
      inString =
        true;
      continue;
    }

    if (
      character ===
      "{"
    ) {
      depth++;
      continue;
    }

    if (
      character ===
      "}"
    ) {
      depth--;

      if (
        depth ===
        0
      ) {
        return text.slice(
          start,
          index + 1
        );
      }
    }
  }

  return null;
}

/*
 * =========================================================
 * RÉPARATION JSON
 * =========================================================
 */

function repairJsonString(
  text: string
): string {
  return text
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      ""
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
 * STRUCTURE
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
 * LIMITATION
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
 * TYPE ÉVÉNEMENT
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
 * DÉDUPLICATION
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
 * DÉJÀ STOCKÉ
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
 * PSG
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
 * XML
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
 * EXTRACTION PAGE
 * =========================================================
 */

function extractPageText(
  html: string
): string {
  let text =
    html;

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
 * URL
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
 * TEXTE
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
 * HTML ENTITIES
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
 * MOTS
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
    ).length;
}

/*
 * =========================================================
 * JOUR
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
 * SLUG
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

  return `${base}-${Date.now()}`;
}

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
 * FETCH TIMEOUT
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
 * ERREUR
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
