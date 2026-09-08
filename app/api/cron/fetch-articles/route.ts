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
     * 3. DÉDUPLICATION RSS
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
     * 5. CONSTRUCTION DES CLUSTERS
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
     * 7. TRAITEMENT DES CLUSTERS
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
   * =========================================================
   * ENRICHISSEMENT
   * =========================================================
   */

  const enrichment =
    await enrichSources(
      sorted
    );

  /*
   * =========================================================
   * PREMIÈRE GÉNÉRATION GEMINI
   * =========================================================
   */

  let geminiCalls = 1;

  const firstGeneration =
    await generateArticle(
      enrichment.sources
    );

  if (
    firstGeneration.ok ===
    false
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
          firstGeneration.reason,

        detail:
          firstGeneration.error,
      },

      enrichment,

      geminiCalls,
    };
  }

  let article =
    normalizeArticle(
      firstGeneration.article
    );

  let words =
    countWords(
      article.content
    );

  /*
   * =========================================================
   * RETRY / ENRICHISSEMENT DE LA PREMIÈRE VERSION
   * =========================================================
   */

  if (
    words <
    MIN_ARTICLE_WORDS
  ) {
    geminiCalls++;

    const retry =
      await generateArticle(
        enrichment.sources,
        true,
        article
      );

    if (
      retry.ok ===
      true
    ) {
      const retryArticle =
        normalizeArticle(
          retry.article
        );

      const retryWords =
        countWords(
          retryArticle.content
        );

      /*
       * On conserve toujours
       * la version la plus longue.
       */

      if (
        retryWords >
        words
      ) {
        article =
          retryArticle;

        words =
          retryWords;
      }
    }
  }

  /*
   * =========================================================
   * SECOND RETRY SI NÉCESSAIRE
   * =========================================================
   *
   * Si Gemini n'a toujours pas fourni
   * assez de matière, on lui demande
   * une seconde extension ciblée.
   */

  if (
    words <
    MIN_ARTICLE_WORDS
  ) {
    geminiCalls++;

    const secondRetry =
      await generateArticle(
        enrichment.sources,
        true,
        article,
        true
      );

    if (
      secondRetry.ok ===
      true
    ) {
      const secondArticle =
        normalizeArticle(
          secondRetry.article
        );

      const secondWords =
        countWords(
          secondArticle.content
        );

      if (
        secondWords >
        words
      ) {
        article =
          secondArticle;

        words =
          secondWords;
      }
    }
  }

  /*
   * =========================================================
   * ARTICLE TOUJOURS TROP COURT
   * =========================================================
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
          "too_short_after_retry",

        detail:
          `title=${article.title.length}, words=${words}, excerpt=${article.excerpt.length}`,
      },

      enrichment,

      geminiCalls,
    };
  }

  /*
   * =========================================================
   * PROTECTION DOUBLON APRÈS GÉNÉRATION
   * =========================================================
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

      geminiCalls,
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

      geminiCalls,
    };
  }

  const sourceUrl =
    sorted[0]?.link ||
    null;

  /*
   * =========================================================
   * CRÉATION ARTICLE
   * =========================================================
   */

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

      geminiCalls,
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

      geminiCalls,
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
    /\b(heure|quelle chaine|quelle chaîne|chaine tv|chaîne tv|composition|compo|compositions|blessure|blesse|blessé|forfait|transfert|transferts|mercato|contrat|prolongation|arbitre|stade|diffusion|direct|ballon d'or|ballon dor|absent|absents|absence|maillot|maillots|parc des princes|travaux|renovation|rénovation)\b/i.test(
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
  sources: ArticleInput[],
  retry = false,
  previousArticle?: GeminiArticle,
  secondRetry = false
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

  const previousArticleText =
    previousArticle
      ? `
VERSION ACTUELLE À ENRICHIR :

Titre :
${previousArticle.title}

Chapô :
${previousArticle.excerpt}

Article :
${previousArticle.content}

IMPORTANT :
Cette version contient déjà des informations valides.
Tu dois la conserver comme base et l'enrichir avec les informations supplémentaires présentes dans les sources.
Ne supprime pas les faits importants déjà présents.
`
      : "";

  const retryInstruction =
    retry
      ? `
ATTENTION : la version précédente était trop courte.

Tu dois produire une version beaucoup plus développée.

OBJECTIF :
600 à 800 mots minimum.

Tu dois exploiter au maximum les informations factuelles disponibles dans les sources.

Recherche et intègre, UNIQUEMENT lorsqu'elles sont présentes :

- date précise
- heure précise
- adversaire
- compétition
- journée
- stade
- lieu
- diffusion TV
- chaîne
- streaming
- compositions
- joueurs titulaires
- joueurs absents
- blessures
- suspensions
- forfaits
- arbitre
- conférence de presse
- déclarations
- entraîneur
- contexte
- forme récente
- résultats récents
- classement
- enjeux
- mercato
- transfert
- contrat
- prolongation
- entraînement
- maillot
- travaux
- rénovation
- informations concernant le Parc des Princes
- toute autre information concrète présente dans les sources

Ne fais surtout pas une simple répétition de la première version.

Chaque nouvelle information factuelle pertinente doit être intégrée naturellement.

Si les sources contiennent suffisamment de matière, développe l'article jusqu'à environ 600 à 800 mots.

Si plusieurs sources parlent du même sujet, fusionne leurs informations.

Si une source contient un sujet secondaire différent, ne l'utilise pas pour changer le sujet principal.

N'invente absolument rien.
`
      : "";

  const secondRetryInstruction =
    secondRetry
      ? `
DEUXIÈME TENTATIVE D'ENRICHISSEMENT.

La version précédente reste insuffisamment développée.

Tu dois impérativement produire un article d'au moins 500 mots lorsque les sources permettent de le faire.

Ne raccourcis pas le contenu.

Ajoute des paragraphes utiles à partir des informations réellement présentes dans les sources.

Analyse particulièrement les informations longues récupérées depuis les pages des médias.

Cherche les détails concrets :
- qui ?
- quoi ?
- quand ?
- où ?
- pourquoi ?
- comment ?
- conséquences ?
- contexte ?
- prochaines échéances ?

Utilise toutes les informations vérifiables qui concernent le sujet principal.

Ne remplis pas artificiellement.
N'invente rien.
`
      : "";

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Ta mission est de transformer plusieurs sources d'actualité en UN SEUL article original de presse sportive sur le Paris Saint-Germain.

${retryInstruction}

${secondRetryInstruction}

${previousArticleText}

============================================================
OBJECTIF ÉDITORIAL
============================================================

Produire un véritable article de presse sportive.

L'article doit être concret, informatif et utile au lecteur.

Il ne doit jamais être une reformulation vague des titres RSS.

Les informations détaillées présentes dans les pages des médias doivent être exploitées.

============================================================
FUSION DES SOURCES
============================================================

Plusieurs sources peuvent parler du même événement.

Exemple :

Source A :
Le PSG joue samedi à 21h.

Source B :
Le match est diffusé sur Canal+.

Source C :
Le match se joue au Parc des Princes.

L'article final doit réunir ces informations dans UN SEUL article.

Les doublons servent à enrichir l'article.

Ils ne doivent jamais créer plusieurs articles.

============================================================
RÈGLES ABSOLUES
============================================================

1. Utilise uniquement les informations présentes dans les sources.

2. N'invente aucune information.

3. Ne complète jamais une information avec tes connaissances personnelles.

4. Ne devine jamais une date.

5. Ne devine jamais une heure.

6. Ne devine jamais un stade.

7. Ne devine jamais une chaîne TV.

8. Ne devine jamais une plateforme de streaming.

9. Ne devine jamais une composition.

10. Ne devine jamais une absence.

11. Ne devine jamais une blessure.

12. Ne devine jamais un résultat.

13. Ne devine jamais une déclaration.

14. Ne devine jamais un classement.

15. Ne mélange jamais deux événements différents.

16. Ne mélange jamais deux matchs différents.

17. Ne mélange jamais deux adversaires différents.

18. Ne mélange jamais deux joueurs différents.

19. Ne mélange jamais deux transferts différents.

20. Si une source mentionne plusieurs événements, utilise uniquement les informations concernant le sujet principal.

21. Une information présente dans plusieurs sources est particulièrement fiable.

22. Une information provenant d'une seule source peut être utilisée si elle est clairement présentée.

23. Si une information est incertaine, présente-la comme telle.

24. Ne mentionne jamais Gemini.

25. Ne mentionne jamais l'IA.

26. Ne copie jamais les phrases originales.

27. Réécris entièrement les informations.

28. Le français doit être naturel.

29. Chaque paragraphe doit apporter une information utile.

30. Évite les phrases génériques.

31. Ne répète pas inutilement la même information.

32. Ne transforme pas l'article en liste de faits.

33. Utilise des paragraphes journalistiques.

34. Les intertitres doivent apporter une vraie information.

============================================================
INFORMATIONS À EXPLOITER
============================================================

Lorsque présentes dans les sources :

- date
- heure
- adversaire
- compétition
- journée
- stade
- lieu
- diffusion TV
- chaîne
- streaming
- compositions
- joueurs
- absents
- blessés
- suspendus
- forfaits
- arbitre
- conférence de presse
- déclarations
- entraîneur
- contexte
- forme récente
- résultats récents
- classement
- enjeux
- mercato
- transfert
- contrat
- prolongation
- entraînement
- maillot
- Parc des Princes
- travaux
- rénovation
- calendrier
- prochaine échéance
- toute information concrète disponible

============================================================
SOURCES MULTI-SUJETS
============================================================

Si un titre contient plusieurs sujets, par exemple :

"PSG-Monaco & PSG-Bratislava"

ce titre ne doit pas permettre de mélanger les deux événements.

Utilise uniquement les informations correspondant au sujet principal du cluster.

============================================================
ABSENCE D'INFORMATION
============================================================

Si l'information n'est pas dans les sources :

ne l'invente pas.

Exemple :

Si les sources disent seulement :

"Le PSG joue samedi"

écris que le PSG joue samedi.

N'ajoute pas d'heure.

Si les sources ne donnent pas de chaîne TV :

ne donne aucune chaîne.

============================================================
STYLE
============================================================

Le style doit être celui d'un média sportif professionnel français.

Évite :

"Le PSG s'apprête à vivre un moment important."

"Cette rencontre sera très intéressante."

"Les supporters attendent avec impatience."

Ces phrases sont trop génériques lorsqu'elles ne contiennent aucun fait.

Privilégie :

des faits,
des informations,
du contexte,
des dates,
des horaires,
des noms,
des lieux,
des enjeux,
des déclarations,
des informations de groupe.

============================================================
STRUCTURE
============================================================

Titre :

Titre précis, journalistique et informatif.

Chapô :

2 ou 3 phrases avec les informations principales.

Corps :

## Premier intertitre informatif

Plusieurs paragraphes apportant les faits essentiels.

## Deuxième intertitre informatif

Informations complémentaires et contexte.

## Troisième intertitre informatif

Détails disponibles dans les différentes sources.

## Les dernières informations

Informations récentes ou prochaines échéances lorsqu'elles sont présentes.

Conclusion :

Courte conclusion utile.

============================================================
LONGUEUR
============================================================

Première génération :

environ 500 à 800 mots.

Deuxième génération :

600 à 800 mots lorsque les sources le permettent.

Deuxième tentative d'enrichissement :

au moins 500 mots lorsque les informations disponibles le permettent.

Ne remplis jamais artificiellement l'article.

Il vaut mieux un article plus court mais totalement factuel qu'un article long contenant des informations inventées.

============================================================
FORMAT
============================================================

Retourne UNIQUEMENT un objet JSON valide.

AUCUN texte avant le JSON.

AUCUN texte après le JSON.

AUCUNE balise Markdown autour du JSON.

Format :

{
  "title": "Titre de l'article",
  "excerpt": "Chapô de l'article",
  "content": "Contenu complet en Markdown"
}

Le contenu peut contenir des retours à la ligne.

============================================================
SOURCES
============================================================

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
                      4500,

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
 * PARSING JSON GEMINI
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
     * Continue.
     */
  }

  /*
   * Recherche d'un objet JSON
   * dans une éventuelle réponse
   * contenant du texte autour.
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
     * Dernière tentative :
     * suppression des caractères
     * de contrôle.
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
 * VALIDATION GEMINI
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
 * STRUCTURE ARTICLE
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
    const normalizedTitle =
      normalizeForComparison(
        item.title
      );

    /*
     * =======================================================
     * IMPORTANT :
     * Un titre qui contient plusieurs adversaires
     * est considéré comme ambigu.
     *
     * Exemple :
     *
     * PSG-Monaco & PSG-Bratislava
     *
     * Il ne doit pas pouvoir polluer
     * le cluster Monaco ou Bratislava.
     * =======================================================
     */

    const opponents =
      extractAllOpponents(
        normalizedTitle
      );

    if (
      opponents.length >
      1
    ) {
      continue;
    }

    /*
     * =======================================================
     * Recherche du meilleur cluster.
     * =======================================================
     */

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

/*
 * =========================================================
 * SIMILARITÉ CLUSTER
 * =========================================================
 */

function similarityToCluster(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  const itemTitle =
    normalizeForComparison(
      item.title
    );

  const itemOpponents =
    extractAllOpponents(
      itemTitle
    );

  /*
   * Un titre ambigu ne peut jamais
   * être fusionné.
   */

  if (
    itemOpponents.length >
    1
  ) {
    return 0;
  }

  const itemOpponent =
    itemOpponents[0] ||
    null;

  const clusterOpponents =
    [
      ...new Set(
        cluster
          .map(
            (entry) =>
              extractAllOpponents(
                normalizeForComparison(
                  entry.title
                )
              )
          )
          .flat()
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

  /*
   * =======================================================
   * DEUX ADVERSAIRES DIFFÉRENTS =
   * JAMAIS LE MÊME CLUSTER
   * =======================================================
   */

  if (
    itemOpponent &&
    clusterOpponents.length >
      0
  ) {
    const differentOpponent =
      clusterOpponents.some(
        (opponent) =>
          opponent !==
          itemOpponent
      );

    if (
      differentOpponent
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

/*
 * =========================================================
 * SIMILARITÉ HISTOIRE
 * =========================================================
 */

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

  const opponentsA =
    extractAllOpponents(
      titleA
    );

  const opponentsB =
    extractAllOpponents(
      titleB
    );

  /*
   * Titres ambigus :
   * aucune fusion automatique.
   */

  if (
    opponentsA.length >
      1 ||
    opponentsB.length >
      1
  ) {
    return 0;
  }

  const opponentA =
    opponentsA[0] ||
    null;

  const opponentB =
    opponentsB[0] ||
    null;

  /*
   * Deux adversaires différents =
   * événements différents.
   */

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
 * TOUS LES ADVERSAIRES
 * =========================================================
 */

function extractAllOpponents(
  title: string
): string[] {
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

  const found =
    opponents.filter(
      (opponent) =>
        title.includes(
          opponent
        )
    );

  /*
   * Bratislava et Slovan désignent
   * le même adversaire.
   */

  if (
    found.includes(
      "slovan bratislava"
    ) ||
    found.includes(
      "bratislava"
    ) ||
    found.includes(
      "slovan"
    )
  ) {
    return [
      "slovan bratislava",
    ];
  }

  return [
    ...new Set(
      found
    ),
  ];
}

/*
 * =========================================================
 * ADVERSAIRE PRINCIPAL
 * =========================================================
 */

function extractOpponent(
  title: string
): string | null {
  return (
    extractAllOpponents(
      title
    )[0] ||
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
    "maillot",
    "maillots",
    "travaux",
    "renovation",
    "rénovation",
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
 * EXTRACTION PAGE WEB
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
 * SIMILARITÉ TITRE
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
 * NORMALISATION
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
