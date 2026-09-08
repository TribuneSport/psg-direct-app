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
const GEMINI_TIMEOUT_MS = 6000;

type FeedItem = {
  source: string;
  priority: number;
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
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

type Diagnostic = {
  cluster: number;
  sources: string[];
  titles: string[];
  outcome: string;
  detail?: string;
};

export async function GET(req: NextRequest) {
  try {
    const secret =
      req.nextUrl.searchParams.get("secret");

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
        RSS_FEEDS.map(async (feed) => {
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
            clearTimeout(timeout);
          }
        })
      );

    const allItems: FeedItem[] = [];

    for (const result of rssResults) {
      if (
        result.status ===
        "rejected"
      ) {
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : String(
                result.reason
              );

        rssErrors.push(
          error.slice(0, 250)
        );

        continue;
      }

      const { feed, items } =
        result.value;

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

      for (const item of limitedItems) {
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
          !item.url
        ) {
          continue;
        }

        if (
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
      await prisma.article.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: 100,
        select: {
          title: true,
          sourceUrl: true,
        },
      });

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
            (url) =>
              normalizeUrl(url)
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

    const geminiErrors: string[] =
      [];

    const diagnostics: Diagnostic[] =
      [];

    /*
     * IMPORTANT :
     * On élimine d'abord les clusters déjà connus.
     * Cela évite que le cluster le plus récent bloque
     * indéfiniment les nouveaux sujets.
     */
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
            const hasExistingUrl =
              cluster.some(
                (item) =>
                  existingSourceUrls.has(
                    normalizeUrl(
                      item.url
                    )
                  )
              );

            if (
              hasExistingUrl
            ) {
              skipped++;

              return false;
            }

            const orderedCluster =
              [...cluster].sort(
                (a, b) =>
                  a.priority -
                  b.priority
              );

            const representative =
              orderedCluster[0];

            const duplicateTitle =
              recentArticles.some(
                (article) =>
                  areSimilarTitles(
                    article.title,
                    representative.title
                  )
              );

            if (
              duplicateTitle
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

      geminiCalls++;

      const generatedResult =
        await generateArticle(
          cluster
        );

      if (
        generatedResult.ok === false
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

      if (
        generated.title.length <
          20 ||
        generated.content.length <
          300
      ) {
        tooShort++;
        deferred++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "too_short",
          detail:
            `title=${generated.title.length}, excerpt=${generated.excerpt.length}, content=${generated.content.length}`,
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
        await prisma.article.findUnique({
          where: {
            slug,
          },
          select: {
            id: true,
          },
        });

      if (existingSlug) {
        skipped++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "duplicate_slug",
          detail: slug,
        });

        continue;
      }

      try {
        await prisma.article.create({
          data: {
            title:
              generated.title,
            slug,
            content:
              generated.content,
            excerpt:
              generated.excerpt,
            club: "PSG",
            status: "DRAFT",
            isAiGenerated:
              true,
            sourceUrl:
              representative.url,
          },
        });

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
        });
      } catch (error) {
        createErrors++;
        deferred++;

        const detail =
          error instanceof Error
            ? error.message
            : "Erreur DB inconnue";

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "create_error",
          detail:
            detail.slice(0, 300),
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

      diagnostics: {
        geminiCalls,

        geminiSuccess,

        geminiErrors,

        invalidJson,

        tooShort,

        slugErrors,

        createErrors,

        rssErrors,

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
          error instanceof Error
            ? error.message
            : "Erreur inconnue",
      },
      { status: 500 }
    );
  }
}

async function generateArticle(
  cluster: FeedItem[]
): Promise<GenerationResult> {
  const orderedCluster =
    [...cluster].sort(
      (a, b) =>
        a.priority -
        b.priority
    );

  const evidence =
    orderedCluster
      .map(
        (item, index) =>
          [
            `SOURCE ${index + 1} — ${item.source}`,
            `Titre: ${item.title}`,
            `Date de publication: ${
              item.publishedAt ??
              "non précisée"
            }`,
            `URL: ${item.url}`,
            `Informations: ${
              item.description ||
              "Aucune description disponible"
            }`,
          ].join("\n")
      )
      .join("\n\n");

  const prompt = `
Tu es le rédacteur sportif de PSG Direct.

Transforme les sources ci-dessous en UN SEUL article original consacré au Paris Saint-Germain.

OBJECTIF :

Produire un article de presse sportive française précis, factuel et utile.

RÈGLE ABSOLUE :

N'INVENTE AUCUNE INFORMATION.

Utilise uniquement les faits présents dans les sources.

Lorsque l'information est disponible, indique notamment :

- date du match
- heure du match
- stade
- compétition
- journée
- adversaire
- chaîne TV
- plateforme de diffusion
- joueurs concernés
- entraîneur
- composition probable
- blessure
- suspension
- mercato
- déclaration
- résultat
- contexte sportif
- enjeu du match

Si une information n'est pas présente dans les sources, ne l'invente pas.

Si plusieurs sources parlent du même événement, fusionne leurs informations au lieu de répéter les mêmes faits.

Une information présente dans deux sources peut être considérée comme fortement confirmée.

Une information présente dans une seule source peut être utilisée mais doit être formulée prudemment si nécessaire.

Ne fais pas de remplissage.

Évite les phrases génériques comme :
"Cette rencontre s'annonce passionnante"
"Les supporters attendent avec impatience"
"Le PSG devra être concentré"
si elles n'apportent aucune information concrète.

Le PSG doit rester au centre de l'article.

Le titre doit être informatif et spécifique.

L'extrait doit résumer les faits principaux.

Le contenu doit développer les informations disponibles.

IMPORTANT :

Si les sources donnent une heure, une date, un stade ou une diffusion,
ces informations doivent apparaître dans l'article.

Si plusieurs sources donnent des informations complémentaires,
combine-les dans le même article.

Ne transforme jamais une absence d'information en affirmation.

Style :
- français
- naturel
- journalistique
- sportif
- précis
- lisible
- professionnel

Lorsque les sources contiennent suffisamment de matière,
vise environ 400 à 700 mots.

Retourne uniquement ce JSON :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}

SOURCES :

${evidence}
`;

  const models = [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
  ];

  let lastFailure:
    GenerationFailure | null =
    null;

  for (
    let modelIndex = 0;
    modelIndex <
    models.length;
    modelIndex++
  ) {
    const model =
      models[modelIndex];

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        GEMINI_TIMEOUT_MS
      );

    try {
      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY!,
            },

            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      text: prompt,
                    },
                  ],
                },
              ],

              generationConfig: {
                temperature: 0.2,

                responseMimeType:
                  "application/json",

                responseSchema: {
                  type: "OBJECT",

                  properties: {
                    title: {
                      type: "STRING",
                    },

                    excerpt: {
                      type: "STRING",
                    },

                    content: {
                      type: "STRING",
                    },
                  },

                  required: [
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
          GenerationFailure = {
          ok: false,

          outcome:
            `gemini_${model}_http_${response.status}`,

          error:
            `Modèle ${model} — HTTP ${response.status}: ${raw.slice(
              0,
              500
            )}`,
        };

        lastFailure =
          failure;

        const canFallback =
          modelIndex <
            models.length - 1 &&
          [429, 500, 502, 503, 504].includes(
            response.status
          );

        if (canFallback) {
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
        return {
          ok: false,
          outcome:
            "invalid_json",
          error:
            `Réponse Gemini non JSON: ${raw.slice(
              0,
              500
            )}`,
        };
      }

      const candidate =
        data.candidates?.[0];

      const finishReason =
        candidate?.finishReason ??
        "unknown";

      const text =
        candidate?.content?.parts
          ?.map(
            (part) =>
              part.text || ""
          )
          .join("")
          .trim() || "";

      if (!text) {
        return {
          ok: false,
          outcome:
            `gemini_empty_${finishReason}`,
          error:
            `Aucun texte Gemini. finishReason=${finishReason}`,
        };
      }

      const parsed =
        parseGeminiJSON(
          text
        );

      if (!parsed) {
        return {
          ok: false,
          outcome:
            "invalid_json",
          error:
            `JSON article invalide: ${text.slice(
              0,
              500
            )}`,
        };
      }

      return {
        ok: true,
        article: parsed,
      };
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Erreur Gemini inconnue";

      const failure:
        GenerationFailure = {
        ok: false,

        outcome:
          error instanceof Error &&
          error.name ===
            "AbortError"
            ? `gemini_timeout_${model}`
            : `gemini_exception_${model}`,

        error:
          `Modèle ${model} — ${detail.slice(
            0,
            500
          )}`,
      };

      lastFailure =
        failure;

      if (
        modelIndex <
          models.length - 1 &&
        error instanceof Error &&
        error.name !==
          "AbortError"
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
        cleaned.slice(7);
    }

    if (
      cleaned.startsWith(
        "```"
      )
    ) {
      cleaned =
        cleaned.slice(3);
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

    const parsed =
      JSON.parse(
        cleaned
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

function parseRSS(
  xml: string
): Array<{
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
}> {
  const results: Array<{
    title: string;
    description: string;
    url: string;
    publishedAt: string | null;
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
      !title ||
      !url
    ) {
      continue;
    }

    results.push({
      title,
      description,
      url,
      publishedAt,
    });
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
    xml.match(regex);

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

function isRelevantToPSG(
  title: string,
  description: string
): boolean {
  const text =
    `${title} ${description}`
      .toLowerCase();

  const strongKeywords = [
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

  const hasPSGSignal =
    strongKeywords.some(
      (keyword) =>
        text.includes(
          keyword
        )
    );

  if (!hasPSGSignal) {
    return false;
  }

  const directPSGSignals = [
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

  const omSignals = [
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

function buildClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters:
    FeedItem[][] = [];

  for (
    const item of items
  ) {
    let best:
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

        best =
          cluster;
      }
    }

    if (
      best &&
      bestScore >= 0.42
    ) {
      best.push(item);
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
    cluster.length === 0
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
          title * 0.65 +
          entities * 0.25 +
          dates * 0.1
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
  const entities = [
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
    new Date(a).getTime();

  const db =
    new Date(b).getTime();

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
    .normalize("NFD")
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
        token.length >= 3 &&
        !stopWords.has(
          token
        )
    );
}

function normalizeUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(url);

    parsed.hash = "";

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

function getLatestDate(
  cluster: FeedItem[]
): number {
  if (
    cluster.length === 0
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

function slugify(
  value: string
): string {
  return value
    .toLowerCase()
    .normalize("NFD")
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
