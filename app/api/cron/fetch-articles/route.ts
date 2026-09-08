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

/*
 * Objectif quotidien :
 * 20 articles minimum lorsqu'il existe suffisamment
 * de sujets réellement différents.
 *
 * Il n'y a volontairement PAS de plafond quotidien.
 * Les grosses journées PSG peuvent donc dépasser 20 articles.
 */
const DAILY_TARGET = 20;

/*
 * Nombre maximum d'articles générés par une seule
 * exécution du cron.
 *
 * Cela évite de lancer trop d'appels Gemini dans
 * une seule fonction Vercel.
 */
const MAX_NEW_ARTICLES_PER_RUN = 5;

const MAX_SOURCES_PER_ARTICLE = 5;

const RSS_TIMEOUT_MS = 4000;
const SOURCE_TIMEOUT_MS = 1800;
const GEMINI_TIMEOUT_MS = 5000;

const MIN_ARTICLE_WORDS = 400;
const MAX_ARTICLE_WORDS = 900;

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

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  const secret = new URL(req.url).searchParams.get("secret");

  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return NextResponse.json(
      {
        error: "Unauthorized",
      },
      { status: 401 }
    );
  }

  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      {
        error: "GEMINI_API_KEY is missing",
      },
      { status: 500 }
    );
  }

  const diagnostics: Diagnostic[] = [];
  const rssErrors: string[] = [];

  try {
    /*
     * ---------------------------------------------------------
     * 1. RÉCUPÉRATION DES RSS
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
                "User-Agent": "PSG-Direct/1.0",
              },
            }
          );

          const items = parseRSS(xml, feed.name);

          return {
            feed: feed.name,
            items,
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

    /*
     * ---------------------------------------------------------
     * 2. FUSION DES SOURCES
     * ---------------------------------------------------------
     */

    const allItems = feeds.flatMap(
      (result) => result.items
    );

    const relevantItems = allItems.filter(
      isRelevantPSG
    );

    const uniqueItems =
      deduplicateItems(relevantItems);

    /*
     * ---------------------------------------------------------
     * 3. ARTICLES DÉJÀ PRÉSENTS
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

    const newItems = uniqueItems.filter(
      (item) =>
        !isAlreadyStored(
          item,
          recentArticles
        )
    );

    /*
     * ---------------------------------------------------------
     * 4. CLUSTERISATION
     * ---------------------------------------------------------
     *
     * Un même sujet provenant de plusieurs médias
     * devient UN seul article.
     */

    const clusters =
      buildSimpleClusters(newItems);

    const candidateClusters = clusters
      .filter(
        (cluster) => cluster.length > 0
      )
      .sort(
        (a, b) =>
          clusterPriority(b) -
          clusterPriority(a)
      );

    /*
     * ---------------------------------------------------------
     * 5. COMPTEUR QUOTIDIEN
     * ---------------------------------------------------------
     *
     * On compte les articles IA PSG créés depuis
     * le début de la journée.
     *
     * Ce compteur est un objectif et non un plafond.
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

    /*
     * Combien manque-t-il pour atteindre l'objectif
     * de 20 articles aujourd'hui ?
     */
    const remainingDailyTarget =
      Math.max(
        0,
        DAILY_TARGET -
          articlesCreatedToday
      );

    /*
     * ---------------------------------------------------------
     * 6. NOMBRE DE CLUSTERS À TRAITER
     * ---------------------------------------------------------
     *
     * On génère au maximum 5 articles par passage.
     *
     * Si nous sommes sous l'objectif de 20,
     * on essaie de rattraper le retard.
     *
     * Si nous sommes déjà à 20 ou plus,
     * on continue quand même s'il existe de nouveaux
     * sujets pertinents.
     */

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

    let created = 0;
    let skipped = 0;

    /*
     * Cette liste est enrichie au fur et à mesure
     * qu'un article est créé afin d'éviter qu'un second
     * cluster de la même exécution génère un titre
     * quasiment identique.
     */

    const articlesForDuplicateCheck =
      [...recentArticles];

    /*
     * ---------------------------------------------------------
     * 7. GÉNÉRATION DES ARTICLES
     * ---------------------------------------------------------
     */

    for (
      let index = 0;
      index < selectedClusters.length;
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

      if (result.created) {
        created++;

        /*
         * On ajoute immédiatement le titre généré
         * à la mémoire locale.
         */
        articlesForDuplicateCheck.push({
          title:
            result.articleTitle || "",
          slug: "",
          sourceUrl:
            result.sourceUrl || null,
        });
      } else {
        skipped++;
      }
    }

    /*
     * ---------------------------------------------------------
     * 8. NOUVEAU TOTAL DU JOUR
     * ---------------------------------------------------------
     */

    const totalCreatedToday =
      articlesCreatedToday +
      created;

    return NextResponse.json({
      checked: allItems.length,
      newItems: newItems.length,
      clusters: clusters.length,
      candidateClusters:
        candidateClusters.length,
      processedClusters:
        selectedClusters.length,
      deferred: Math.max(
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
      sourcesOk: feeds
        .filter(
          (feed) => !feed.error
        )
        .map(
          (feed) => feed.feed
        ),
      sources: RSS_FEEDS.map(
        (feed) => feed.name
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
              (item) => item.detail
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
        sourcePagesFetched: 0,
        sourcePagesFailed: 0,
        enrichedCharacters: 0,
        sourcePageErrors: [],
        clusters: diagnostics,
      },
      elapsedMs:
        Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          getErrorMessage(error),
        elapsedMs:
          Date.now() - startedAt,
      },
      { status: 500 }
    );
  }
}

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
}> {
  const sources = [
    ...new Set(
      cluster.map(
        (item) => item.source
      )
    ),
  ];

  const titles = cluster.map(
    (item) => item.title
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

  const enriched =
    await enrichSources(sorted);

  const generation =
    await generateArticle(
      enriched
    );

  if (generation.ok === false) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome: generation.reason,
        detail: generation.error,
      },
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
        cluster: clusterNumber,
        sources,
        titles,
        outcome: "too_short",
        detail:
          `title=${article.title.length}, words=${words}, excerpt=${article.excerpt.length}`,
      },
    };
  }

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
        cluster: clusterNumber,
        sources,
        titles,
        outcome:
          "duplicate_after_generation",
        detail: article.title,
      },
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
        cluster: clusterNumber,
        sources,
        titles,
        outcome: "slug_error",
        detail:
          getErrorMessage(error),
      },
    };
  }

  const sourceUrl =
    sorted[0]?.link || null;

  try {
    await prisma.article.create({
      data: {
        title: article.title,
        slug,
        excerpt: article.excerpt,
        content: article.content,
        club: "PSG",
        status: "DRAFT",
        isAiGenerated: true,
        sourceUrl,
      },
    });

    return {
      created: true,
      articleTitle: article.title,
      sourceUrl,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome: "created",
        detail:
          `words=${words}, sources=${sorted.length}`,
      },
    };
  } catch (error) {
    return {
      created: false,
      articleTitle: null,
      sourceUrl: null,
      diagnostic: {
        cluster: clusterNumber,
        sources,
        titles,
        outcome: "create_error",
        detail:
          getErrorMessage(error),
      },
    };
  }
}

async function enrichSources(
  items: FeedItem[]
): Promise<ArticleInput[]> {
  const results =
    await Promise.all(
      items.map(
        async (item) => {
          let description =
            cleanText(
              item.description
            );

          if (
            countWords(
              description
            ) < 80
          ) {
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
                        "Mozilla/5.0 PSG-Direct/1.0",
                    },
                  }
                );

              const extracted =
                extractPageText(
                  page
                );

              if (
                extracted.length >
                description.length
              ) {
                description =
                  extracted.slice(
                    0,
                    5000
                  );
              }
            } catch {
              // La page source est facultative.
              // Le RSS reste utilisable.
            }
          }

          return {
            title: item.title,
            description,
            source: item.source,
            link: item.link,
          };
        }
      )
    );

  return results;
}

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
        (source, index) =>
          [
            `SOURCE ${index + 1}`,
            `Média : ${source.source}`,
            `Titre : ${source.title}`,
            `Informations : ${source.description}`,
            `Lien : ${source.link}`,
          ].join("\n")
      )
      .join("\n\n");

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
- N'invente aucun joueur.
- N'invente aucun transfert.
- N'invente aucun résultat.
- N'invente aucune déclaration.
- Si une information n'est pas présente dans les sources, ne l'affirme pas.
- Les sources peuvent parler du même événement avec des informations différentes : fusionne uniquement les informations qui concernent exactement le même sujet.
- Ne mélange jamais deux matchs différents.
- Ne mélange jamais deux transferts différents.
- Ne mélange jamais deux joueurs différents sauf si les sources les relient clairement.
- Ne mentionne pas l'intelligence artificielle.
- Ne copie pas les phrases originales.
- Rédige dans un français naturel et journalistique.
- Donne la priorité aux informations factuelles et vérifiables.
- Lorsqu'une même information apparaît dans plusieurs sources, considère-la comme particulièrement fiable.
- Lorsqu'une information n'apparaît que dans une seule source, tu peux l'utiliser si elle est clairement attribuée à cette source.
- Ne transforme jamais une hypothèse en certitude.

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
- déclarations présentes dans les sources
- contexte sportif
- classement lorsqu'il est présent dans les sources
- forme récente lorsqu'elle est présente dans les sources
- mercato et transferts uniquement lorsqu'ils sont réellement présents dans les sources

STRUCTURE OBLIGATOIRE :

- Un titre précis.
- Un chapô de 2 à 3 phrases.
- Une introduction.
- 3 à 5 intertitres Markdown commençant par ##.
- Des paragraphes courts.
- Une conclusion.

IMPORTANT POUR LES INTERTITRES :

Les intertitres doivent être spécifiques au sujet traité.

N'utilise PAS des titres génériques comme :
"Les dernières informations"
"Ce qu'il faut retenir"
"Un contexte à suivre"

Utilise plutôt des intertitres correspondant réellement aux informations disponibles.

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

Le champ content doit conserver de vrais retours à la ligne entre les paragraphes.

SOURCES :

${sourceText}
`;

  const response =
    await callGemini(prompt);

  if (response.ok === false) {
    return {
      ok: false,
      reason:
        "generation_error",
      error: response.error,
    };
  }

  const parsed =
    parseGeminiJson(
      response.text
    );

  if (!parsed) {
    return {
      ok: false,
      reason: "invalid_json",
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
      reason: "invalid_json",
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

  for (const model of models) {
    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(() => {
          controller.abort();
        }, GEMINI_TIMEOUT_MS);

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
                  maxOutputTokens: 2200,
                  responseMimeType:
                    "application/json",
                },
              }),
              signal:
                controller.signal,
              cache: "no-store",
            }
          );

        if (!response.ok) {
          const body =
            await response.text();

          errors.push(
            `Gemini ${model}: HTTP ${response.status}${
              body
                ? ` - ${body.slice(0, 250)}`
                : ""
            }`
          );

          continue;
        }

        const json =
          await response.json();

        const text =
          json?.candidates?.[0]
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
        clearTimeout(timeout);
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
      errors.join(" | ") ||
      "Gemini request failed",
  };
}

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
      JSON.parse(cleaned);

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
      title: parsed.title,
      excerpt: parsed.excerpt,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

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
    countWords(content);

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

function addBasicStructure(
  content: string
): string {
  const paragraphs =
    content
      .split(/\n\s*\n/)
      .map(
        (paragraph) =>
          paragraph.trim()
      )
      .filter(Boolean);

  if (
    paragraphs.length < 4
  ) {
    return content;
  }

  const result: string[] =
    [];

  result.push(
    paragraphs[0]
  );

  const remaining =
    paragraphs.slice(1);

  for (
    let index = 0;
    index < remaining.length;
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

function trimToWords(
  text: string,
  maxWords: number
): string {
  const words =
    text
      .split(/\s+/)
      .filter(Boolean);

  if (
    words.length <=
    maxWords
  ) {
    return text;
  }

  return (
    words
      .slice(0, maxWords)
      .join(" ") +
    "..."
  );
}

function buildSimpleClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters:
    FeedItem[][] = [];

  for (const item of items) {
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
        score > bestScore
      ) {
        bestScore =
          score;

        bestCluster =
          cluster;
      }
    }

    if (
      bestCluster &&
      bestScore >= 0.72
    ) {
      bestCluster.push(
        item
      );
    } else {
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
          .map((entry) =>
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
              Boolean(opponent)
          )
      ),
    ];

  if (
    itemOpponent &&
    clusterOpponents.length > 0 &&
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
    const score =
      simpleStorySimilarity(
        item,
        other
      );

    if (
      score > best
    ) {
      best = score;
    }
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
    tokensA.length === 0 ||
    tokensB.length === 0
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
    "nîmes",
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

  for (
    const opponent of opponents
  ) {
    if (
      title.includes(
        opponent
      )
    ) {
      return opponent;
    }
  }

  return null;
}

function extractEvent(
  title: string
): string | null {
  const events = [
    "composition",
    "compo",
    "compositions",
    "equipe type",
    "équipe type",
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

  for (
    const event of events
  ) {
    if (
      title.includes(event)
    ) {
      return event;
    }
  }

  return null;
}

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

  if (
    itemUrl &&
    articles.some(
      (article) =>
        normalizeUrl(
          article.sourceUrl ||
            ""
        ) === itemUrl
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

function isRelevantPSG(
  item: FeedItem
): boolean {
  const text =
    normalizeForComparison(
      `${item.title} ${item.description}`
    );

  return (
    text.includes("psg") ||
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

  if (!itemMatches) {
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
        cleanText(title),
      description:
        cleanText(
          description
        ),
      link:
        cleanUrl(link),
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

  return (
    match?.[1] || ""
  );
}

function extractPageText(
  html: string
): string {
  let text = html;

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

  const articleMatch =
    text.match(
      /<article[^>]*>([\s\S]*?)<\/article>/i
    );

  if (articleMatch) {
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
    stripHtml(text);

  return cleanArticleContent(
    decodeHtmlEntities(
      text
    )
  ).slice(0, 5000);
}

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
      cluster.length * 5,
      20
    );

  return score;
}

function sourcePriority(
  source: string
): number {
  switch (source) {
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
    .split(/\s+/)
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
    tokensA.size === 0 ||
    tokensB.size === 0
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

function normalizeForComparison(
  text: string
): string {
  return decodeHtmlEntities(
    text
  )
    .normalize("NFD")
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

function normalizeUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(url);

    parsed.hash = "";

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

function cleanText(
  text: string
): string {
  return decodeHtmlEntities(
    stripHtml(text)
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

/*
 * Nettoyage du contenu d'article.
 *
 * Contrairement à cleanText(), cette fonction conserve
 * les retours à la ligne afin que les paragraphes Markdown
 * restent correctement séparés dans l'article.
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

function countWords(
  text: string
): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function getStartOfToday(): Date {
  const now =
    new Date();

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
}

async function makeUniqueSlug(
  title: string
): Promise<string> {
  const base =
    slugify(title);

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

  if (!existing) {
    return slug;
  }

  slug =
    `${base}-${Date.now()}`;

  return slug;
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
    .slice(0, 90);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  options: RequestInit
): Promise<string> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, timeoutMs);

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

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function getErrorMessage(
  error: unknown
): string {
  if (
    error instanceof Error
  ) {
    return error.message;
  }

  return String(error);
}
