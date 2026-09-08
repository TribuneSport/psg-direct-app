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

type FeedItem = {
  source: string;
  priority: number;
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
};

type EnrichedSource = {
  item: FeedItem;
  pageTitle: string;
  pageDescription: string;
  pageText: string;
  pageFetched: boolean;
  error?: string;
};

type ArticleResult = {
  title: string;
  excerpt: string;
  content: string;
};

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type GenerationSuccess = {
  ok: true;
  article: ArticleResult;
};

type GenerationFailure = {
  ok: false;
  outcome: string;
  error: string;
};

type GenerationResult =
  | GenerationSuccess
  | GenerationFailure;

type GeminiModel = {
  name: string;
  timeout: number;
};

type Diagnostic = {
  cluster: number;
  sources: string[];
  titles: string[];
  outcome: string;
  detail?: string;
};

export async function GET(
  req: NextRequest
) {
  try {
    const secret =
      req.nextUrl.searchParams.get(
        "secret"
      );

    if (!CRON_SECRET) {
      return NextResponse.json(
        {
          error:
            "CRON_SECRET n'est pas configuré sur Vercel",
        },
        { status: 500 }
      );
    }

    if (secret !== CRON_SECRET) {
      return NextResponse.json(
        {
          error: "non autorisé",
        },
        { status: 401 }
      );
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY n'est pas configurée sur Vercel",
        },
        { status: 500 }
      );
    }

    const sources =
      RSS_FEEDS.map(
        (feed) => feed.name
      );

    const sourcesOk: string[] = [];
    const rssErrors: string[] = [];

    const rssResults =
      await Promise.allSettled(
        RSS_FEEDS.map(
          async (feed) => {
            const controller =
              new AbortController();

            const timeout =
              setTimeout(
                () =>
                  controller.abort(),
                RSS_TIMEOUT_MS
              );

            try {
              const response =
                await fetch(
                  feed.url,
                  {
                    headers: {
                      Accept:
                        "application/rss+xml, application/xml, text/xml",
                      "User-Agent":
                        "PSG-Direct/1.0",
                    },
                    cache: "no-store",
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

              return {
                feed,
                items:
                  parseRSS(xml),
              };
            } finally {
              clearTimeout(
                timeout
              );
            }
          }
        )
      );

    const allItems: FeedItem[] = [];

    for (
      const result of rssResults
    ) {
      if (
        result.status ===
        "rejected"
      ) {
        rssErrors.push(
          (
            result.reason instanceof
            Error
              ? result.reason.message
              : String(result.reason)
          ).slice(0, 250)
        );

        continue;
      }

      const {
        feed,
        items,
      } = result.value;

      if (items.length > 0) {
        sourcesOk.push(
          feed.name
        );
      }

      const limitedItems =
        [...items]
          .sort(
            (a, b) =>
              dateValue(
                b.publishedAt
              ) -
              dateValue(
                a.publishedAt
              )
          )
          .slice(
            0,
            MAX_ITEMS_PER_SOURCE
          );

      for (
        const item of limitedItems
      ) {
        const title =
          cleanText(
            item.title
          );

        const description =
          cleanText(
            item.description
          );

        if (
          !title ||
          !item.url ||
          !isRelevantToPSG(
            title,
            description
          )
        ) {
          continue;
        }

        allItems.push({
          source:
            feed.name,
          priority:
            feed.priority,
          title,
          description,
          url: item.url,
          publishedAt:
            item.publishedAt,
        });
      }
    }

    const uniqueItems =
      deduplicateByUrl(
        allItems
      );

    const clusters =
      buildClusters(
        uniqueItems
      );

    const recentArticles =
      await prisma.article.findMany(
        {
          orderBy: {
            createdAt:
              "desc",
          },
          take: 100,
          select: {
            title: true,
            sourceUrl: true,
          },
        }
      );

    const existingSourceUrls =
      new Set(
        recentArticles
          .map(
            (article) =>
              article.sourceUrl
          )
          .filter(
            (
              url
            ): url is string =>
              typeof url ===
                "string" &&
              url.length > 0
          )
          .map(
            normalizeUrl
          )
      );

    let created = 0;
    let skipped = 0;
    let duplicates = 0;
    let deferred = 0;

    let geminiCalls = 0;
    let geminiSuccess = 0;
    let invalidJson = 0;
    let tooShort = 0;
    let slugErrors = 0;
    let createErrors = 0;

    let sourcePagesFetched = 0;
    let sourcePagesFailed = 0;
    let enrichedCharacters = 0;

    const geminiErrors: string[] =
      [];

    const sourcePageErrors: string[] =
      [];

    const diagnostics: Diagnostic[] =
      [];

    const candidateClusters =
      clusters
        .slice()
        .sort(
          (a, b) =>
            getLatestDate(b) -
            getLatestDate(a)
        )
        .filter(
          (cluster) => {
            if (
              cluster.some(
                (item) =>
                  existingSourceUrls.has(
                    normalizeUrl(
                      item.url
                    )
                  )
              )
            ) {
              skipped++;
              return false;
            }

            const representative =
              [...cluster].sort(
                (a, b) =>
                  a.priority -
                  b.priority
              )[0];

            if (
              recentArticles.some(
                (article) =>
                  areSimilarTitles(
                    article.title,
                    representative.title
                  )
              )
            ) {
              duplicates++;
              return false;
            }

            return true;
          }
        );

    deferred = Math.max(
      0,
      candidateClusters.length -
        Math.min(
          candidateClusters.length,
          MAX_CLUSTERS_TO_PROCESS
        )
    );

    const clustersToProcess =
      candidateClusters.slice(
        0,
        MAX_CLUSTERS_TO_PROCESS
      );

    for (
      let index = 0;
      index <
      clustersToProcess.length;
      index++
    ) {
      const cluster =
        clustersToProcess[
          index
        ];

      if (
        created >=
        MAX_NEW_ARTICLES
      ) {
        deferred++;
        continue;
      }

      const orderedCluster =
        [...cluster].sort(
          (a, b) =>
            a.priority -
            b.priority
        );

      const representative =
        orderedCluster[0];

      const diagnosticBase = {
        cluster:
          index + 1,
        sources: [
          ...new Set(
            cluster.map(
              (item) =>
                item.source
            )
          ),
        ],
        titles:
          cluster
            .map(
              (item) =>
                item.title
            )
            .slice(0, 5),
      };

      /*
       * ÉTAPE IMPORTANTE :
       *
       * On récupère maintenant les pages
       * originales avant d'envoyer les données
       * à Gemini.
       *
       * Gemini reçoit donc :
       * - RSS
       * - titre original
       * - description RSS
       * - contenu de la page
       * - titre de page
       * - description de page
       */
      const enriched =
        await enrichCluster(
          cluster,
          sourcePageErrors
        );

      sourcePagesFetched +=
        enriched.filter(
          (source) =>
            source.pageFetched
        ).length;

      sourcePagesFailed +=
        enriched.filter(
          (source) =>
            !source.pageFetched
        ).length;

      enrichedCharacters +=
        enriched.reduce(
          (
            sum,
            source
          ) =>
            sum +
            source.pageText
              .length,
          0
        );

      geminiCalls++;

      let generatedResult =
        await generateArticle(
          enriched
        );

      /*
       * Si Gemini produit encore moins
       * de 400 mots, deuxième passage.
       */
      if (
        generatedResult.ok &&
        countWords(
          generatedResult
            .article
            .content
        ) < 400
      ) {
        geminiCalls++;

        const expandedResult =
          await expandArticle(
            enriched,
            generatedResult.article
          );

        if (
          "error" in
          expandedResult
        ) {
          geminiErrors.push(
            expandedResult.error
          );

          diagnostics.push({
            ...diagnosticBase,
            outcome:
              expandedResult.outcome,
            detail:
              expandedResult.error,
          });
        } else {
          generatedResult =
            expandedResult;
        }
      }

      if (
        generatedResult.ok ===
        false
      ) {
        deferred++;

        geminiErrors.push(
          generatedResult.error
        );

        if (
          generatedResult.outcome.includes(
            "invalid_json"
          )
        ) {
          invalidJson++;
        }

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            generatedResult.outcome,
          detail:
            generatedResult.error,
        });

        continue;
      }

      geminiSuccess++;

      const generated =
        generatedResult.article;

      const wordCount =
        countWords(
          generated.content
        );

      /*
       * CONTRÔLE QUALITÉ
       *
       * On conserve la règle des 400 mots.
       * On ne crée pas d'article faible.
       */
      if (
        generated.title
          .length < 20 ||
        wordCount < 400
      ) {
        tooShort++;
        deferred++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "too_short",
          detail:
            `title=${generated.title.length}, words=${wordCount}, excerpt=${generated.excerpt.length}, enriched=${enrichedCharacters}`,
        });

        continue;
      }

      const slug =
        slugify(
          generated.title
        );

      if (!slug) {
        slugErrors++;
        deferred++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "invalid_slug",
        });

        continue;
      }

      const existingSlug =
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

      if (existingSlug) {
        skipped++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "duplicate_slug",
          detail:
            slug,
        });

        continue;
      }

      try {
        await prisma.article.create(
          {
            data: {
              title:
                generated.title,

              slug,

              content:
                generated.content,

              excerpt:
                generated.excerpt,

              club: "PSG",

              status:
                "DRAFT",

              isAiGenerated:
                true,

              sourceUrl:
                representative.url,
            },
          }
        );

        created++;

        existingSourceUrls.add(
          normalizeUrl(
            representative.url
          )
        );

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "created",
          detail:
            `words=${wordCount}, sources=${enriched.length}, pages=${sourcePagesFetched}, chars=${enrichedCharacters}`,
        });
      } catch (error) {
        createErrors++;
        deferred++;

        const detail =
          error instanceof
          Error
            ? error.message
            : "Erreur DB inconnue";

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "create_error",
          detail:
            detail.slice(
              0,
              300
            ),
        });
      }
    }

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

      deferred,

      created,

      skipped,

      duplicates,

      sourcesOk,

      sources,

      fusion: true,

      optimized: true,

      enrichment: true,

      diagnostics: {
        geminiCalls,

        geminiSuccess,

        geminiErrors,

        invalidJson,

        tooShort,

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
    });
  } catch (error) {
    console.error(
      "fetch-articles error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Erreur lors de la récupération des articles",

        details:
          error instanceof
          Error
            ? error.message
            : "Erreur inconnue",
      },
      { status: 500 }
    );
  }
}

/*
 * ============================================================
 * ENRICHISSEMENT DES SOURCES
 * ============================================================
 */

async function enrichCluster(
  cluster: FeedItem[],
  errors: string[]
): Promise<EnrichedSource[]> {
  const ordered =
    [...cluster].sort(
      (a, b) =>
        a.priority -
        b.priority
    );

  /*
   * Priorité aux sources dont le RSS
   * contient peu d'informations.
   *
   * Si aucune source n'est courte,
   * on prend quand même jusqu'à 3 pages.
   */
  const candidates =
    ordered
      .filter(
        (item) =>
          item.description
            .length < 800
      )
      .slice(
        0,
        MAX_SOURCE_PAGES
      );

  const selected =
    candidates.length > 0
      ? candidates
      : ordered.slice(
          0,
          MAX_SOURCE_PAGES
        );

  const results =
    await Promise.allSettled(
      selected.map(
        async (
          item
        ): Promise<EnrichedSource> => {
          const controller =
            new AbortController();

          const timeout =
            setTimeout(
              () =>
                controller.abort(),
              SOURCE_PAGE_TIMEOUT_MS
            );

          try {
            const response =
              await fetch(
                item.url,
                {
                  headers: {
                    Accept:
                      "text/html,application/xhtml+xml",
                    "User-Agent":
                      "PSG-Direct/1.0",
                  },

                  cache:
                    "no-store",

                  redirect:
                    "follow",

                  signal:
                    controller.signal,
                }
              );

            if (!response.ok) {
              throw new Error(
                `HTTP ${response.status}`
              );
            }

            const html =
              await response.text();

            const extracted =
              extractPageContent(
                html
              );

            if (
              !extracted.text
            ) {
              throw new Error(
                "contenu de page introuvable"
              );
            }

            return {
              item,

              pageTitle:
                extracted.pageTitle,

              pageDescription:
                extracted.pageDescription,

              pageText:
                extracted.text,

              pageFetched:
                true,
            };
          } finally {
            clearTimeout(
              timeout
            );
          }
        }
      )
    );

  const output: EnrichedSource[] =
    [];

  for (
    let i = 0;
    i < results.length;
    i++
  ) {
    const result =
      results[i];

    const item =
      selected[i];

    if (
      result.status ===
      "fulfilled"
    ) {
      output.push(
        result.value
      );
    } else {
      const error =
        result.reason instanceof
        Error
          ? result.reason.message
          : String(
              result.reason
            );

      errors.push(
        `${item.source}: ${error}`.slice(
          0,
          300
        )
      );

      output.push({
        item,

        pageTitle: "",

        pageDescription:
          "",

        pageText: "",

        pageFetched:
          false,

        error,
      });
    }
  }

  /*
   * Les autres sources du cluster
   * restent dans l'évidence même si leur
   * page n'a pas été récupérée.
   */
  const fetchedUrls =
    new Set(
      output.map(
        (source) =>
          normalizeUrl(
            source.item.url
          )
      )
    );

  for (
    const item of ordered
  ) {
    if (
      !fetchedUrls.has(
        normalizeUrl(
          item.url
        )
      )
    ) {
      output.push({
        item,

        pageTitle: "",

        pageDescription:
          "",

        pageText: "",

        pageFetched:
          false,
      });
    }
  }

  return output;
}

/*
 * Extraction simple et robuste du contenu
 * d'une page HTML.
 */
function extractPageContent(
  html: string
): {
  pageTitle: string;
  pageDescription: string;
  text: string;
} {
  const pageTitle =
    cleanText(
      extractMeta(
        html,
        "og:title"
      ) ||
        extractTag(
          html,
          "title"
        )
    );

  const pageDescription =
    cleanText(
      extractMeta(
        html,
        "description"
      ) ||
        extractMeta(
          html,
          "og:description"
        )
    );

  const articleMatch =
    html.match(
      /<article\b[^>]*>([\s\S]*?)<\/article>/i
    );

  const mainMatch =
    html.match(
      /<main\b[^>]*>([\s\S]*?)<\/main>/i
    );

  const body =
    articleMatch?.[1] ||
    mainMatch?.[1] ||
    html;

  const withoutNoise =
    body
      .replace(
        /<script\b[\s\S]*?<\/script>/gi,
        " "
      )
      .replace(
        /<style\b[\s\S]*?<\/style>/gi,
        " "
      )
      .replace(
        /<nav\b[\s\S]*?<\/nav>/gi,
        " "
      )
      .replace(
        /<footer\b[\s\S]*?<\/footer>/gi,
        " "
      )
      .replace(
        /<header\b[\s\S]*?<\/header>/gi,
        " "
      );

  let text =
    withoutNoise
      .replace(
        /<br\s*\/?>/gi,
        "\n"
      )
      .replace(
        /<\/p>/gi,
        "\n"
      )
      .replace(
        /<\/h[1-6]>/gi,
        "\n"
      )
      .replace(
        /<[^>]*>/g,
        " "
      );

  text =
    decodeXML(text)
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return {
    pageTitle,

    pageDescription,

    text:
      text.slice(
        0,
        MAX_SOURCE_TEXT_LENGTH
      ),
  };
}

function extractMeta(
  html: string,
  name: string
): string {
  const escaped =
    name.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const regex1 =
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    );

  const regex2 =
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i"
    );

  return (
    html.match(
      regex1
    )?.[1] ||
    html.match(
      regex2
    )?.[1] ||
    ""
  );
}

/*
 * ============================================================
 * GEMINI
 * ============================================================
 */

async function generateArticle(
  sources: EnrichedSource[]
): Promise<GenerationResult> {
  const evidence =
    buildEvidence(
      sources
    );

  const prompt = `
Tu es le rédacteur sportif de PSG Direct.

Transforme les sources RSS et les pages web récupérées ci-dessous en UN SEUL article original consacré au Paris Saint-Germain.

OBJECTIF :
Produire un véritable article de presse sportive française, précis, factuel, développé et utile aux supporters du PSG.

RÈGLE ABSOLUE :
N'INVENTE AUCUNE INFORMATION.

Utilise exclusivement les informations présentes dans les sources RSS et dans les pages récupérées.

Lorsque l'information est disponible, indique notamment :

- date du match ou de l'événement
- heure
- stade
- compétition
- journée de championnat
- adversaire
- diffusion TV
- plateforme de diffusion
- joueurs concernés
- entraîneur
- composition
- blessure
- suspension
- mercato
- déclaration
- résultat
- contexte
- enjeu
- décision officielle
- conséquences

Si une information n'est pas présente dans les sources, ne l'invente pas.

Si plusieurs sources parlent du même sujet, fusionne leurs informations en UN SEUL article.

Ne crée surtout pas plusieurs articles pour une même actualité.

Une information retrouvée dans plusieurs sources peut être utilisée comme élément confirmé.

Une information provenant d'une seule source peut être utilisée si elle est clairement présentée comme provenant de cette source.

Ne transforme jamais une rumeur en certitude.

IMPORTANT :
Le contenu doit contenir AU MINIMUM 400 MOTS.

Le contenu doit comporter entre 6 et 8 paragraphes distincts.

Chaque paragraphe doit apporter une information concrète, un élément de contexte ou une explication utile.

Évite les phrases génériques du type :
"Les supporters attendent avec impatience..."
"Cette rencontre sera très importante..."
"Le PSG devra être concentré..."

si elles n'apportent aucun fait nouveau.

Ne remplis pas artificiellement le texte.

Ne répète pas les mêmes informations.

Le PSG doit rester au centre de l'article.

Le titre doit être précis et informatif.

L'extrait doit résumer les faits principaux.

STYLE :
Français naturel.
Journalistique.
Sportif.
Professionnel.
Précis.
Fluide.

Retourne uniquement ce JSON :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}

SOURCES ET PAGES ENRICHIES :

${evidence}
`;

  return callGemini(
    prompt
  );
}

async function expandArticle(
  sources: EnrichedSource[],
  article: ArticleResult
): Promise<GenerationResult> {
  const evidence =
    buildEvidence(
      sources
    );

  const prompt = `
Tu es le rédacteur sportif de PSG Direct.

L'article ci-dessous est trop court.

Réécris-le intégralement pour obtenir AU MINIMUM 400 MOTS et entre 6 et 8 paragraphes.

RÈGLE ABSOLUE :
N'INVENTE AUCUNE INFORMATION.

Utilise exclusivement :
1. l'article actuel
2. les sources RSS
3. les pages web récupérées

Conserve tous les faits exacts.

Développe uniquement les informations réellement disponibles :
- date
- heure
- stade
- compétition
- journée
- adversaire
- diffusion
- joueurs
- entraîneur
- blessure
- suspension
- mercato
- déclarations
- résultat
- contexte
- enjeu
- décision officielle
- conséquences

Ne complète jamais avec tes connaissances générales.

Ne crée aucune information absente des sources.

Ne répète pas artificiellement les mêmes phrases.

Chaque paragraphe doit apporter un élément concret.

ARTICLE ACTUEL :

Titre :
${article.title}

Extrait :
${article.excerpt}

Contenu :
${article.content}

SOURCES ET PAGES ENRICHIES :

${evidence}

Retourne uniquement ce JSON :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}
`;

  return callGemini(
    prompt
  );
}

function buildEvidence(
  sources: EnrichedSource[]
): string {
  return sources
    .map(
      (
        source,
        index
      ) => {
        const item =
          source.item;

        return [
          `SOURCE ${index + 1} — ${item.source}`,

          `Titre RSS: ${item.title}`,

          `Date RSS: ${
            item.publishedAt ??
            "non précisée"
          }`,

          `URL: ${item.url}`,

          `Description RSS: ${
            item.description ||
            "Aucune"
          }`,

          `Titre de page: ${
            source.pageTitle ||
            "non récupéré"
          }`,

          `Description de page: ${
            source.pageDescription ||
            "non récupérée"
          }`,

          `Page récupérée: ${
            source.pageFetched
              ? "oui"
              : "non"
          }`,

          `Faits extraits de la page: ${
            source.pageText ||
            "Aucun contenu supplémentaire récupéré"
          }`,
        ].join("\n");
      }
    )
    .join(
      "\n\n"
    );
}

async function callGemini(
  prompt: string
): Promise<GenerationResult> {
  const models: GeminiModel[] =
    [
      {
        name:
          "gemini-3.5-flash-lite",
        timeout: 4500,
      },
      {
        name:
          "gemini-3.6-flash",
        timeout: 1500,
      },
    ];

  let lastFailure:
    | GenerationFailure
    | null = null;

  for (
    let modelIndex = 0;
    modelIndex <
    models.length;
    modelIndex++
  ) {
    const modelConfig =
      models[modelIndex];

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        modelConfig.timeout
      );

    try {
      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.name}:generateContent`,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY!,
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
                      0.2,

                    maxOutputTokens:
                      2200,

                    responseMimeType:
                      "application/json",

                    responseSchema:
                      {
                        type:
                          "OBJECT",

                        properties:
                          {
                            title:
                              {
                                type:
                                  "STRING",
                              },

                            excerpt:
                              {
                                type:
                                  "STRING",
                              },

                            content:
                              {
                                type:
                                  "STRING",
                              },
                          },

                        required:
                          [
                            "title",
                            "excerpt",
                            "content",
                          ],
                      },
                  },
              }),

            signal:
              controller.signal,
          }
        );

      const raw =
        await response.text();

      if (!response.ok) {
        const failure:
          GenerationFailure =
          {
            ok: false,

            outcome:
              `gemini_${modelConfig.name}_http_${response.status}`,

            error:
              `Modèle ${modelConfig.name} — HTTP ${response.status}: ${raw.slice(
                0,
                500
              )}`,
          };

        lastFailure =
          failure;

        if (
          modelIndex <
          models.length - 1
        ) {
          continue;
        }

        return failure;
      }

      let data:
        GeminiResponse;

      try {
        data =
          JSON.parse(
            raw
          ) as GeminiResponse;
      } catch {
        const failure:
          GenerationFailure =
          {
            ok: false,

            outcome:
              `invalid_json_${modelConfig.name}`,

            error:
              `Réponse Gemini non JSON: ${raw.slice(
                0,
                500
              )}`,
          };

        lastFailure =
          failure;

        if (
          modelIndex <
          models.length - 1
        ) {
          continue;
        }

        return failure;
      }

      const candidate =
        data
          .candidates?.[0];

      const finishReason =
        candidate?.finishReason ??
        "unknown";

      const text =
        candidate?.content?.parts
          ?.map(
            (
              part
            ) =>
              part.text ||
              ""
          )
          .join("")
          .trim() ||
        "";

      if (!text) {
        const failure:
          GenerationFailure =
          {
            ok: false,

            outcome:
              `gemini_empty_${modelConfig.name}_${finishReason}`,

            error:
              `Aucun texte Gemini. Modèle=${modelConfig.name}, finishReason=${finishReason}`,
          };

        lastFailure =
          failure;

        if (
          modelIndex <
          models.length - 1
        ) {
          continue;
        }

        return failure;
      }

      const parsed =
        parseGeminiJSON(
          text
        );

      if (!parsed) {
        const failure:
          GenerationFailure =
          {
            ok: false,

            outcome:
              `invalid_json_${modelConfig.name}`,

            error:
              `JSON article invalide avec ${modelConfig.name}: ${text.slice(
                0,
                500
              )}`,
          };

        lastFailure =
          failure;

        if (
          modelIndex <
          models.length - 1
        ) {
          continue;
        }

        return failure;
      }

      return {
        ok: true,
        article:
          parsed,
      };
    } catch (error) {
      const isAbort =
        error instanceof
          Error &&
        error.name ===
          "AbortError";

      const detail =
        error instanceof
        Error
          ? error.message
          : "Erreur Gemini inconnue";

      const failure:
        GenerationFailure =
        {
          ok: false,

          outcome:
            isAbort
              ? `gemini_timeout_${modelConfig.name}`
              : `gemini_exception_${modelConfig.name}`,

          error:
            `Modèle ${modelConfig.name} — ${detail.slice(
              0,
              500
            )}`,
        };

      lastFailure =
        failure;

      if (
        modelIndex <
        models.length - 1
      ) {
        continue;
      }

      return failure;
    } finally {
      clearTimeout(
        timeout
      );
    }
  }

  return (
    lastFailure ?? {
      ok: false,

      outcome:
        "gemini_unavailable",

      error:
        "Aucun modèle Gemini disponible",
    }
  );
}

/*
 * ============================================================
 * PARSING GEMINI
 * ============================================================
 */

function countWords(
  value: string
): number {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function parseGeminiJSON(
  text: string
): ArticleResult | null {
  try {
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

    const parsed =
      JSON.parse(
        cleaned.trim()
      ) as Partial<ArticleResult>;

    if (
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
        cleanText(
          parsed.title
        ),

      excerpt:
        cleanText(
          parsed.excerpt
        ),

      content:
        cleanGeneratedText(
          parsed.content
        ),
    };
  } catch {
    return null;
  }
}

/*
 * ============================================================
 * RSS
 * ============================================================
 */

function parseRSS(
  xml: string
): Array<{
  title: string;
  description: string;
  url: string;
  publishedAt:
    | string
    | null;
}> {
  const results: Array<{
    title: string;
    description: string;
    url: string;
    publishedAt:
      | string
      | null;
  }> = [];

  const itemMatches =
    xml.match(
      /<item[\s\S]*?<\/item>/gi
    ) ?? [];

  for (
    const itemXml of itemMatches
  ) {
    const title =
      extractTag(
        itemXml,
        "title"
      );

    const description =
      extractTag(
        itemXml,
        "description"
      ) ||
      extractTag(
        itemXml,
        "content:encoded"
      ) ||
      "";

    const url =
      extractTag(
        itemXml,
        "link"
      ) ||
      extractTag(
        itemXml,
        "guid"
      ) ||
      "";

    const publishedAt =
      extractTag(
        itemXml,
        "pubDate"
      ) ||
      extractTag(
        itemXml,
        "dc:date"
      ) ||
      null;

    if (
      title &&
      url
    ) {
      results.push({
        title,
        description,
        url,
        publishedAt,
      });
    }
  }

  return results;
}

function extractTag(
  xml: string,
  tag: string
): string {
  const escapedTag =
    tag.replace(
      ":",
      "\\:"
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

  if (!match) {
    return "";
  }

  return decodeXML(
    match[1].trim()
  );
}

function decodeXML(
  value: string
): string {
  return value
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/gi,
      "$1"
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
      /&#39;/g,
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

function cleanText(
  value: string
): string {
  return value
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<[^>]*>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function cleanGeneratedText(
  value: string
): string {
  return value
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

/*
 * ============================================================
 * PERTINENCE PSG
 * ============================================================
 */

function isRelevantToPSG(
  title: string,
  description: string
): boolean {
  const text =
    `${title} ${description}`
      .toLowerCase();

  const strongKeywords =
    [
      "psg",
      "paris saint-germain",
      "paris saint germain",
      "paris sg",
      "paris-sg",
      "psg.fr",

      "luis enrique",

      "dembélé",
      "dembele",

      "hakimi",
      "achraf",

      "vitinha",

      "marquinhos",

      "donnarumma",

      "kvaratskhelia",

      "barcola",

      "désiré doué",
      "desire doue",

      "joão neves",
      "joao neves",

      "zaïre-emery",
      "zaire-emery",

      "nuno mendes",
    ];

  if (
    !strongKeywords.some(
      (keyword) =>
        text.includes(
          keyword
        )
    )
  ) {
    return false;
  }

  const directPSGSignals =
    [
      "psg",
      "paris saint-germain",
      "paris saint germain",
      "paris sg",
      "paris-sg",
      "psg.fr",
    ];

  const hasDirectPSGSignal =
    directPSGSignals.some(
      (keyword) =>
        text.includes(
          keyword
        )
    );

  const omSignals =
    [
      "olympique de marseille",
      "marseille",
      "vélodrome",
      "velodrome",
    ];

  const hasOMSignal =
    omSignals.some(
      (keyword) =>
        text.includes(
          keyword
        )
    );

  if (
    hasOMSignal &&
    !hasDirectPSGSignal
  ) {
    return false;
  }

  return true;
}

/*
 * ============================================================
 * DÉDOUBLONNAGE
 * ============================================================
 */

function deduplicateByUrl(
  items: FeedItem[]
): FeedItem[] {
  const seen =
    new Set<string>();

  return items.filter(
    (item) => {
      const key =
        normalizeUrl(
          item.url
        );

      if (
        seen.has(key)
      ) {
        return false;
      }

      seen.add(key);

      return true;
    }
  );
}

/*
 * ============================================================
 * CLUSTERS
 * ============================================================
 */

function buildClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters:
    FeedItem[][] = [];

  for (
    const item of items
  ) {
    let best:
      | FeedItem[]
      | null = null;

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

        best =
          cluster;
      }
    }

    if (
      best &&
      bestScore >=
        0.42
    ) {
      best.push(
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
  if (
    cluster.length ===
    0
  ) {
    return 0;
  }

  return Math.max(
    ...cluster.map(
      (other) => {
        const title =
          titleSimilarity(
            item.title,
            other.title
          );

        const entities =
          entitySimilarity(
            `${item.title} ${item.description}`,
            `${other.title} ${other.description}`
          );

        const dates =
          dateSimilarity(
            item.publishedAt,
            other.publishedAt
          );

        return (
          title *
            0.65 +
          entities *
            0.25 +
          dates *
            0.1
        );
      }
    )
  );
}

function titleSimilarity(
  a: string,
  b: string
): number {
  const aa =
    new Set(
      tokenize(
        normalizeTitle(a)
      )
    );

  const bb =
    new Set(
      tokenize(
        normalizeTitle(b)
      )
    );

  if (
    !aa.size ||
    !bb.size
  ) {
    return 0;
  }

  let common = 0;

  for (
    const token of aa
  ) {
    if (
      bb.has(token)
    ) {
      common++;
    }
  }

  return (
    common /
    Math.max(
      aa.size,
      bb.size
    )
  );
}

function entitySimilarity(
  a: string,
  b: string
): number {
  const entities =
    [
      "psg",
      "monaco",
      "marseille",
      "lyon",
      "lens",
      "lille",

      "real madrid",

      "barcelone",
      "barcelona",

      "chelsea",
      "liverpool",
      "arsenal",

      "mbappe",
      "mbappé",

      "dembélé",
      "dembele",

      "hakimi",

      "vitinha",

      "barcola",

      "donnarumma",

      "kvaratskhelia",

      "joao neves",
      "joão neves",
    ];

  const lowerA =
    a.toLowerCase();

  const lowerB =
    b.toLowerCase();

  const aa =
    entities.filter(
      (entity) =>
        lowerA.includes(
          entity
        )
    );

  const bb =
    entities.filter(
      (entity) =>
        lowerB.includes(
          entity
        )
    );

  if (
    !aa.length ||
    !bb.length
  ) {
    return 0;
  }

  return (
    aa.filter(
      (entity) =>
        bb.includes(
          entity
        )
    ).length /
    Math.max(
      aa.length,
      bb.length
    )
  );
}

function dateSimilarity(
  a: string | null,
  b: string | null
): number {
  if (
    !a ||
    !b
  ) {
    return 0;
  }

  const da =
    new Date(
      a
    ).getTime();

  const db =
    new Date(
      b
    ).getTime();

  if (
    !Number.isFinite(
      da
    ) ||
    !Number.isFinite(
      db
    )
  ) {
    return 0;
  }

  const hours =
    Math.abs(
      da - db
    ) /
    3600000;

  if (
    hours <= 24
  ) {
    return 1;
  }

  if (
    hours <= 72
  ) {
    return 0.5;
  }

  return 0;
}

function areSimilarTitles(
  a: string,
  b: string
): boolean {
  return (
    titleSimilarity(
      a,
      b
    ) >= 0.78
  );
}

function normalizeTitle(
  value: string
): string {
  return value
    .toLowerCase()
    .normalize(
      "NFD"
    )
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
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

function tokenize(
  value: string
): string[] {
  const stopWords =
    new Set([
      "avec",
      "pour",
      "dans",
      "mais",
      "une",
      "les",
      "des",
      "sur",
      "entre",
      "apres",
      "avant",
      "chez",
      "cette",
      "tout",
      "tous",
      "plus",
      "moins",
      "contre",
      "depuis",
      "selon",
      "ainsi",
    ]);

  return value
    .split(" ")
    .filter(
      (token) =>
        token.length >=
          3 &&
        !stopWords.has(
          token
        )
    );
}

/*
 * ============================================================
 * URL
 * ============================================================
 */

function normalizeUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(url);

    parsed.hash =
      "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
    ].forEach(
      (key) =>
        parsed.searchParams.delete(
          key
        )
    );

    return parsed
      .toString()
      .replace(
        /\/$/,
        ""
      );
  } catch {
    return url.trim();
  }
}

/*
 * ============================================================
 * DATES
 * ============================================================
 */

function getLatestDate(
  cluster: FeedItem[]
): number {
  if (
    cluster.length ===
    0
  ) {
    return 0;
  }

  return Math.max(
    ...cluster.map(
      (item) =>
        dateValue(
          item.publishedAt
        )
    )
  );
}

function dateValue(
  value: string | null
): number {
  if (!value) {
    return 0;
  }

  const time =
    new Date(
      value
    ).getTime();

  return Number.isFinite(
    time
  )
    ? time
    : 0;
}

/*
 * ============================================================
 * SLUG
 * ============================================================
 */

function slugify(
  value: string
): string {
  return value
    .toLowerCase()
    .normalize(
      "NFD"
    )
    .replace(
      /[\u0300-\u036f]/g,
      ""
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
