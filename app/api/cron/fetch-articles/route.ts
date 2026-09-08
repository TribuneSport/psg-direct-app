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

export async function GET(req: NextRequest) {
  try {
    const secret = req.nextUrl.searchParams.get("secret");

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

    const sources = RSS_FEEDS.map(
      (feed) => feed.name
    );

    const sourcesOk: string[] = [];
    const rssErrors: string[] = [];

    const rssResults = await Promise.allSettled(
      RSS_FEEDS.map(async (feed) => {
        const controller = new AbortController();

        const timeout = setTimeout(
          () => controller.abort(),
          RSS_TIMEOUT_MS
        );

        try {
          const response = await fetch(
            feed.url,
            {
              headers: {
                Accept:
                  "application/rss+xml, application/xml, text/xml",
                "User-Agent":
                  "PSG-Direct/1.0",
              },
              cache: "no-store",
              signal: controller.signal,
            }
          );

          if (!response.ok) {
            throw new Error(
              `HTTP ${response.status} ${response.statusText}`
            );
          }

          const xml = await response.text();

          return {
            feed,
            items: parseRSS(xml),
          };
        } finally {
          clearTimeout(timeout);
        }
      })
    );

    const allItems: FeedItem[] = [];

    for (const result of rssResults) {
      if (result.status === "rejected") {
        rssErrors.push(
          (
            result.reason instanceof Error
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
        sourcesOk.push(feed.name);
      }

      const limitedItems = [...items]
        .sort(
          (a, b) =>
            dateValue(b.publishedAt) -
            dateValue(a.publishedAt)
        )
        .slice(
          0,
          MAX_ITEMS_PER_SOURCE
        );

      for (const item of limitedItems) {
        const title = cleanText(item.title);
        const description = cleanText(
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
          source: feed.name,
          priority: feed.priority,
          title,
          description,
          url: item.url,
          publishedAt:
            item.publishedAt,
        });
      }
    }

    const uniqueItems =
      deduplicateByUrl(allItems);

    const clusters =
      buildClusters(uniqueItems);

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
          .map(normalizeUrl)
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

    const geminiErrors: string[] = [];
    const sourcePageErrors: string[] = [];

    const diagnostics: Diagnostic[] = [];

    const candidateClusters =
      clusters
        .slice()
        .sort(
          (a, b) =>
            getLatestDate(b) -
            getLatestDate(a)
        )
        .filter((cluster) => {
          if (
            cluster.some((item) =>
              existingSourceUrls.has(
                normalizeUrl(item.url)
              )
            )
          ) {
            skipped++;
            return false;
          }

          const representative =
            [...cluster].sort(
              (a, b) =>
                a.priority - b.priority
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
        });

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
      index < clustersToProcess.length;
      index++
    ) {
      const cluster =
        clustersToProcess[index];

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
            a.priority - b.priority
        );

      const representative =
        orderedCluster[0];

      const diagnosticBase = {
        cluster: index + 1,
        sources: [
          ...new Set(
            cluster.map(
              (item) =>
                item.source
            )
          ),
        ],
        titles: cluster
          .map(
            (item) =>
              item.title
          )
          .slice(0, 5),
      };

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
            source.pageText.length,
          0
        );

      geminiCalls++;

      let generatedResult =
        await generateArticle(
          enriched
        );

      if (
        generatedResult.ok &&
        countWords(
          generatedResult
            .article
            .content
        ) < MIN_ARTICLE_WORDS
      ) {
        geminiCalls++;

        const expandedResult =
          await expandArticle(
            enriched,
            generatedResult.article
          );

        if (
          expandedResult.ok === false
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

      const normalizedContent =
        normalizeArticleStructure(
          generated.content
        );

      const wordCount =
        countWords(
          normalizedContent
        );

      if (
        generated.title.length < 20 ||
        wordCount < MIN_ARTICLE_WORDS
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

      const finalContent =
        normalizedContent;

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
            "slug_error",
          detail:
            "Impossible de générer un slug",
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
        duplicates++;
        deferred++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "duplicate_slug",
          detail:
            `slug=${slug}`,
        });

        continue;
      }

      try {
        await prisma.article.create({
          data: {
            title:
              cleanText(
                generated.title
              ),
            slug,
            excerpt:
              cleanText(
                generated.excerpt
              ),
            content:
              finalContent,
            club: "PSG",
            status: "DRAFT",
            isAiGenerated: true,
            sourceUrl:
              representative.url,
          },
        });

        created++;

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "created",
          detail:
            `words=${wordCount}, sources=${cluster.length}, pages=${enriched.filter((source) => source.pageFetched).length}, chars=${enriched.reduce((sum, source) => sum + source.pageText.length, 0)}`,
        });
      } catch (error) {
        createErrors++;
        deferred++;

        const message =
          error instanceof Error
            ? error.message
            : String(error);

        diagnostics.push({
          ...diagnosticBase,
          outcome:
            "create_error",
          detail:
            message.slice(0, 500),
        });
      }
    }

    return NextResponse.json({
      checked:
        RSS_FEEDS.reduce(
          (total, _, index) => {
            const result =
              rssResults[index];

            if (
              result.status ===
              "fulfilled"
            ) {
              return (
                total +
                result.value.items.length
              );
            }

            return total;
          },
          0
        ),
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
        clusters: diagnostics,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      { status: 500 }
    );
  }
}

async function enrichCluster(
  cluster: FeedItem[],
  errors: string[]
): Promise<EnrichedSource[]> {
  const ordered =
    [...cluster]
      .sort(
        (a, b) =>
          a.priority - b.priority
      )
      .slice(
        0,
        MAX_SOURCE_PAGES
      );

  const results =
    await Promise.allSettled(
      ordered.map(
        async (item) => {
          const shouldFetch =
            item.description.length <
              800 ||
            cluster.length > 1;

          if (!shouldFetch) {
            return {
              item,
              pageTitle: "",
              pageDescription: "",
              pageText: "",
              pageFetched: false,
            };
          }

          return fetchSourcePage(
            item
          );
        }
      )
    );

  return results.map(
    (result, index) => {
      if (
        result.status ===
        "fulfilled"
      ) {
        if (
          result.value.error
        ) {
          errors.push(
            `${ordered[index].source}: ${result.value.error}`.slice(
              0,
              500
            )
          );
        }

        return result.value;
      }

      const message =
        result.reason instanceof
        Error
          ? result.reason.message
          : String(
              result.reason
            );

      errors.push(
        `${ordered[index].source}: ${message}`.slice(
          0,
          500
        )
      );

      return {
        item: ordered[index],
        pageTitle: "",
        pageDescription: "",
        pageText: "",
        pageFetched: false,
        error: message,
      };
    }
  );
}

async function fetchSourcePage(
  item: FeedItem
): Promise<EnrichedSource> {
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
              "Mozilla/5.0 (compatible; PSG-Direct/1.0)",
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

    const html =
      await response.text();

    const extracted =
      extractPageContent(
        html
      );

    return {
      item,
      pageTitle:
        extracted.title,
      pageDescription:
        extracted.description,
      pageText:
        extracted.text.slice(
          0,
          MAX_SOURCE_TEXT_LENGTH
        ),
      pageFetched:
        extracted.text.length >
        100,
    };
  } catch (error) {
    return {
      item,
      pageTitle: "",
      pageDescription: "",
      pageText: "",
      pageFetched: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractPageContent(
  html: string
): {
  title: string;
  description: string;
  text: string;
} {
  let cleaned =
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
        /<nav[\s\S]*?<\/nav>/gi,
        " "
      )
      .replace(
        /<footer[\s\S]*?<\/footer>/gi,
        " "
      )
      .replace(
        /<header[\s\S]*?<\/header>/gi,
        " "
      );

  const title =
    extractMeta(
      html,
      "og:title"
    ) ||
    extractTag(
      html,
      "title"
    );

  const description =
    extractMeta(
      html,
      "description"
    ) ||
    extractMeta(
      html,
      "og:description"
    );

  const articleMatch =
    cleaned.match(
      /<article\b[^>]*>([\s\S]*?)<\/article>/i
    );

  const mainMatch =
    cleaned.match(
      /<main\b[^>]*>([\s\S]*?)<\/main>/i
    );

  const source =
    articleMatch?.[1] ||
    mainMatch?.[1] ||
    cleaned;

  const paragraphs =
    [
      ...source.matchAll(
        /<p\b[^>]*>([\s\S]*?)<\/p>/gi
      ),
    ]
      .map(
        (match) =>
          stripHtml(
            match[1]
          )
      )
      .filter(
        (value) =>
          value.length > 40
      );

  const text =
    (
      paragraphs.length > 0
        ? paragraphs.join(
            "\n\n"
          )
        : stripHtml(source)
    )
      .replace(
        /\s+\n/g,
        "\n"
      )
      .replace(
        /\n\s+/g,
        "\n"
      )
      .replace(
        /[ \t]+/g,
        " "
      )
      .trim();

  return {
    title:
      cleanText(title),
    description:
      cleanText(
        description
      ),
    text,
  };
}

function extractMeta(
  html: string,
  name: string
): string {
  const escaped =
    name.replace(
      /[-/\\^$*+?.()|[\]{}]/g,
      "\\$&"
    );

  const patterns = [
    new RegExp(
      `<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match =
      html.match(pattern);

    if (match?.[1]) {
      return decodeHtmlEntities(
        match[1]
      );
    }
  }

  return "";
}

function extractTag(
  html: string,
  tag: string
): string {
  const pattern =
    new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    html.match(pattern);

  return match?.[1]
    ? decodeHtmlEntities(
        stripHtml(
          match[1]
        )
      )
    : "";
}

async function generateArticle(
  sources: EnrichedSource[]
): Promise<GenerationResult> {
  const evidence =
    buildEvidence(
      sources
    );

  const prompt = `
Tu es le journaliste principal de PSG Direct.

Tu dois rédiger un article de presse sportive française ORIGINAL à partir UNIQUEMENT des informations présentes dans les sources fournies.

OBJECTIF :

Produire un véritable article journalistique structuré et agréable à lire.

L'article doit impérativement contenir :

- un titre informatif et précis ;
- un chapô de 2 à 3 phrases ;
- plusieurs intertitres pertinents ;
- des paragraphes courts ;
- une progression logique de l'information ;
- une conclusion naturelle.

STRUCTURE OBLIGATOIRE DU CHAMP "content" :

Le champ content doit être rédigé en Markdown simple.

Utilise exactement cette logique :

Premier paragraphe d'introduction.

## Premier intertitre pertinent

Deux ou trois paragraphes développant cette partie.

## Deuxième intertitre pertinent

Deux ou trois paragraphes développant cette partie.

## Troisième intertitre pertinent

Deux ou trois paragraphes développant cette partie.

## Ce qu'il faut retenir

Un dernier paragraphe de conclusion.

IMPORTANT :

- Chaque paragraphe doit être séparé par une ligne vide.
- Chaque intertitre doit commencer par "## ".
- Ne mets JAMAIS tout l'article dans un seul bloc.
- Ne mets PAS "Introduction" comme intertitre.
- Ne mets PAS "Article" comme intertitre.
- Les intertitres doivent correspondre réellement au contenu.
- Utilise entre 3 et 5 intertitres selon la matière disponible.
- Ne crée pas artificiellement des sections si les informations ne le permettent pas.
- PSG doit rester au centre de l'article.

FACTUALITÉ :

Tu dois utiliser les informations factuelles disponibles :

- date ;
- heure ;
- stade ;
- compétition ;
- journée ;
- adversaire ;
- diffusion TV ;
- plateforme ;
- joueurs ;
- entraîneur ;
- composition ;
- blessure ;
- suspension ;
- transfert ;
- déclaration ;
- résultat ;
- contexte ;
- enjeux ;
- décision officielle ;
- conséquences.

Mais uniquement lorsqu'elles sont présentes dans les sources.

INTERDICTION ABSOLUE D'INVENTER :

Si une information n'est pas présente dans les sources, ne l'invente pas.

Ne crée notamment jamais :

- une heure ;
- une chaîne TV ;
- un stade ;
- une date ;
- une statistique ;
- une déclaration ;
- une composition ;
- une blessure ;
- un transfert ;
- un résultat.

Si une information importante manque, écris simplement l'article avec les informations disponibles.

STYLE :

- français naturel ;
- ton de presse sportive ;
- phrases variées ;
- pas de répétitions ;
- pas de remplissage ;
- pas de phrases génériques ;
- pas de formulation robotique ;
- pas de copier-coller d'une source ;
- reformulation journalistique originale ;
- PSG au centre.

LONGUEUR :

Le contenu doit contenir entre ${MIN_ARTICLE_WORDS} et ${MAX_ARTICLE_WORDS} mots lorsque les sources le permettent.

Le contenu doit être substantiel.

RETOUR OBLIGATOIRE :

Retourne uniquement un JSON valide :

{
  "title": "titre",
  "excerpt": "chapô court",
  "content": "article structuré en Markdown"
}

Aucun texte avant ou après le JSON.

SOURCES :

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
Tu es le rédacteur en chef de PSG Direct.

L'article fourni ci-dessous est trop court.

Tu dois le réécrire intégralement afin d'obtenir un véritable article de presse sportive française structuré.

IMPORTANT :

Conserve tous les faits présents dans l'article.

Tu peux uniquement ajouter des informations présentes dans les sources.

N'invente absolument aucune information.

Le contenu doit impérativement utiliser du Markdown simple.

Structure obligatoire :

Paragraphe de chapô / introduction.

## Intertitre pertinent

Paragraphes courts.

## Intertitre pertinent

Paragraphes courts.

## Intertitre pertinent

Paragraphes courts.

## Ce qu'il faut retenir

Conclusion.

Chaque paragraphe doit être séparé par une ligne vide.

Ne mets jamais tout le texte dans un seul bloc.

Utilise entre 3 et 5 intertitres pertinents.

Minimum ${MIN_ARTICLE_WORDS} mots.

Maximum ${MAX_ARTICLE_WORDS} mots.

PSG doit rester au centre.

ARTICLE ACTUEL :

Titre :
${article.title}

Extrait :
${article.excerpt}

Contenu :
${article.content}

SOURCES :

${evidence}

Retourne uniquement :

{
  "title": "titre",
  "excerpt": "chapô",
  "content": "article structuré en Markdown"
}
`;

  return callGemini(
    prompt
  );
}

async function callGemini(
  prompt: string
): Promise<GenerationResult> {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      outcome: "missing_api_key",
      error:
        "GEMINI_API_KEY manquante",
    };
  }

  const models: GeminiModel[] = [
    {
      name: "gemini-3.5-flash-lite",
      timeout: 4500,
    },
    {
      name: "gemini-3.6-flash",
      timeout: 1500,
    },
  ];

  let lastError =
    "Erreur Gemini inconnue";

  for (const model of models) {
    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          model.timeout
        );

      try {
        const response =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent?key=${encodeURIComponent(
              GEMINI_API_KEY
            )}`,
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
                  temperature: 0.35,
                  maxOutputTokens: 2200,
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

        if (!response.ok) {
          const body =
            await response
              .text()
              .catch(
                () => ""
              );

          throw new Error(
            `HTTP ${response.status}: ${body.slice(
              0,
              300
            )}`
          );
        }

        const data =
          (await response.json()) as GeminiResponse;

        const rawText =
          data.candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;

        if (!rawText) {
          throw new Error(
            "Réponse Gemini vide"
          );
        }

        const parsed =
          parseGeminiJson(
            rawText
          );

        if (!parsed) {
          return {
            ok: false,
            outcome:
              "invalid_json",
            error:
              "Gemini a renvoyé un JSON invalide",
          };
        }

        const article =
          cleanArticle(
            parsed
          );

        if (
          !article.title ||
          !article.content
        ) {
          return {
            ok: false,
            outcome:
              "invalid_article",
            error:
              "Article Gemini incomplet",
          };
        }

        return {
          ok: true,
          article,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error.message
          : String(error);
    }
  }

  return {
    ok: false,
    outcome:
      "gemini_error",
    error:
      lastError.slice(
        0,
        500
      ),
  };
}

function buildEvidence(
  sources: EnrichedSource[]
): string {
  return sources
    .map(
      (source, index) => {
        const item =
          source.item;

        return `
SOURCE ${index + 1}
Nom : ${item.source}
Titre RSS : ${item.title}
Date RSS : ${
          item.publishedAt ||
          "inconnue"
        }
URL : ${item.url}
Description RSS :
${item.description || "Aucune"}

Titre de la page :
${source.pageTitle || "Aucun"}

Description de la page :
${
  source.pageDescription ||
  "Aucune"
}

Contenu récupéré :
${
  source.pageText ||
  "Aucun contenu supplémentaire récupéré."
}
`;
      }
    )
    .join(
      "\n------------------------------\n"
    );
}

function parseGeminiJson(
  text: string
): {
  title?: string;
  excerpt?: string;
  content?: string;
} | null {
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
    return JSON.parse(
      cleaned
    );
  } catch {
    const first =
      cleaned.indexOf(
        "{"
      );

    const last =
      cleaned.lastIndexOf(
        "}"
      );

    if (
      first === -1 ||
      last === -1 ||
      last <= first
    ) {
      return null;
    }

    try {
      return JSON.parse(
        cleaned.slice(
          first,
          last + 1
        )
      );
    } catch {
      return null;
    }
  }
}

function cleanArticle(
  article: {
    title?: string;
    excerpt?: string;
    content?: string;
  }
): ArticleResult {
  return {
    title:
      cleanText(
        article.title ||
          ""
      ),
    excerpt:
      cleanText(
        article.excerpt ||
          ""
      ),
    content:
      normalizeArticleStructure(
        article.content ||
          ""
      ),
  };
}

function normalizeArticleStructure(
  content: string
): string {
  let value =
    content
      .replace(
        /\r\n/g,
        "\n"
      )
      .replace(
        /\r/g,
        "\n"
      )
      .replace(
        /<br\s*\/?>/gi,
        "\n"
      )
      .replace(
        /<\/p>/gi,
        "\n\n"
      )
      .replace(
        /<p[^>]*>/gi,
        ""
      )
      .replace(
        /<h2[^>]*>/gi,
        "\n## "
      )
      .replace(
        /<\/h2>/gi,
        "\n"
      )
      .replace(
        /<strong[^>]*>/gi,
        ""
      )
      .replace(
        /<\/strong>/gi,
        ""
      )
      .replace(
        /<[^>]+>/g,
        " "
      );

  value =
    decodeHtmlEntities(
      value
    );

  value =
    value
      .replace(
        /[ \t]+/g,
        " "
      )
      .replace(
        /[ \t]*\n[ \t]*/g,
        "\n"
      )
      .replace(
        /\n{3,}/g,
        "\n\n"
      )
      .trim();

  const lines =
    value
      .split("\n")
      .map(
        (line) =>
          line.trim()
      )
      .filter(
        (line) =>
          line.length > 0
      );

  const output: string[] = [];

  for (const line of lines) {
    if (
      /^#{1,3}\s+/.test(
        line
      )
    ) {
      const heading =
        line
          .replace(
            /^#{1,3}\s+/,
            ""
          )
          .trim();

      if (
        heading.length >= 8
      ) {
        output.push(
          `## ${heading}`
        );
      }

      continue;
    }

    output.push(
      line
    );
  }

  return buildParagraphs(
    output
  );
}

function buildParagraphs(
  lines: string[]
): string {
  const result: string[] = [];

  let paragraph =
    "";

  for (const line of lines) {
    if (
      line.startsWith(
        "## "
      )
    ) {
      if (
        paragraph.trim()
      ) {
        result.push(
          paragraph.trim()
        );
        paragraph =
          "";
      }

      result.push(
        line
      );

      continue;
    }

    if (
      !paragraph
    ) {
      paragraph =
        line;
      continue;
    }

    if (
      countWords(
        paragraph
      ) < 85 &&
      !looksLikeNewSentence(
        line
      )
    ) {
      paragraph +=
        ` ${line}`;
    } else {
      result.push(
        paragraph.trim()
      );
      paragraph =
        line;
    }
  }

  if (
    paragraph.trim()
  ) {
    result.push(
      paragraph.trim()
    );
  }

  return result
    .join(
      "\n\n"
    )
    .trim();
}

function looksLikeNewSentence(
  line: string
): boolean {
  return /^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ0-9]/.test(
    line
  );
}

function countWords(
  text: string
): number {
  return cleanText(
    text
      .replace(
        /^##\s+/gm,
        ""
      )
  )
    .split(
      /\s+/
    )
    .filter(
      Boolean
    ).length;
}

function parseRSS(
  xml: string
): Array<{
  title: string;
  description: string;
  url: string;
  publishedAt: string | null;
}> {
  const items =
    extractBlocks(
      xml,
      "item"
    );

  return items
    .map(
      (item) => {
        const title =
          extractTag(
            item,
            "title"
          );

        const description =
          extractTag(
            item,
            "description"
          ) ||
          extractTag(
            item,
            "content:encoded"
          );

        const url =
          extractTag(
            item,
            "link"
          ) ||
          extractTag(
            item,
            "guid"
          );

        const publishedAt =
          extractTag(
            item,
            "pubDate"
          ) ||
          extractTag(
            item,
            "published"
          ) ||
          extractTag(
            item,
            "updated"
          );

        return {
          title:
            cleanText(
              title
            ),
          description:
            cleanText(
              description
            ),
          url:
            cleanText(
              url
            ),
          publishedAt:
            publishedAt
              ? new Date(
                  publishedAt
                ).toISOString()
              : null,
        };
      }
    )
    .filter(
      (item) =>
        item.title &&
        item.url
    );
}

function extractBlocks(
  xml: string,
  tag: string
): string[] {
  const pattern =
    new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "gi"
    );

  return [
    ...xml.matchAll(
      pattern
    ),
  ].map(
    (match) =>
      match[1]
  );
}

function cleanText(
  value: string
): string {
  return decodeHtmlEntities(
    stripHtml(
      value
    )
  )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function stripHtml(
  value: string
): string {
  return value
    .replace(
      /<[^>]*>/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function decodeHtmlEntities(
  value: string
): string {
  return value
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

  return Number.isNaN(
    time
  )
    ? 0
    : time;
}

function getLatestDate(
  cluster: FeedItem[]
): number {
  return Math.max(
    ...cluster.map(
      (item) =>
        dateValue(
          item.publishedAt
        )
    )
  );
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

    const removable =
      [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "gclid",
        "fbclid",
      ];

    for (
      const key of removable
    ) {
      parsed.searchParams.delete(
        key
      );
    }

    return parsed
      .toString()
      .replace(
        /\/$/,
        ""
      )
      .toLowerCase();
  } catch {
    return url
      .trim()
      .toLowerCase();
  }
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

  for (const item of items) {
    let bestCluster:
      FeedItem[] | null =
      null;

    let bestScore =
      0;

    for (const cluster of clusters) {
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
        0.34
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

function clusterSimilarity(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  let best =
    0;

  for (const other of cluster) {
    const titleScore =
      titleSimilarity(
        item.title,
        other.title
      );

    const entityScore =
      entitySimilarity(
        item.title,
        other.title
      );

    const dateScore =
      dateSimilarity(
        item.publishedAt,
        other.publishedAt
      );

    const score =
      titleScore * 0.55 +
      entityScore * 0.3 +
      dateScore * 0.15;

    best =
      Math.max(
        best,
        score
      );
  }

  return best;
}

function titleSimilarity(
  a: string,
  b: string
): number {
  const first =
    new Set(
      tokenize(a)
    );

  const second =
    new Set(
      tokenize(b)
    );

  if (
    first.size === 0 ||
    second.size === 0
  ) {
    return 0;
  }

  let intersection =
    0;

  for (const word of first) {
    if (
      second.has(word)
    ) {
      intersection++;
    }
  }

  return (
    intersection /
    Math.max(
      first.size,
      second.size
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
      "paris",
      "saint-germain",
      "monaco",
      "marseille",
      "lyon",
      "lens",
      "lille",
      "ballon d'or",
      "ligue 1",
      "ligue des champions",
      "champions league",
      "dembélé",
      "doué",
      "barcola",
      "hakimi",
      "vitinha",
      "mbappé",
    ];

  const first =
    entities.filter(
      (entity) =>
        a
          .toLowerCase()
          .includes(
            entity
          )
    );

  const second =
    entities.filter(
      (entity) =>
        b
          .toLowerCase()
          .includes(
            entity
          )
    );

  if (
    first.length === 0 ||
    second.length === 0
  ) {
    return 0;
  }

  const common =
    first.filter(
      (entity) =>
        second.includes(
          entity
        )
    ).length;

  return (
    common /
    Math.max(
      first.length,
      second.length
    )
  );
}

function dateSimilarity(
  a: string | null,
  b: string | null
): number {
  if (!a || !b) {
    return 0;
  }

  const first =
    new Date(a);

  const second =
    new Date(b);

  if (
    Number.isNaN(
      first.getTime()
    ) ||
    Number.isNaN(
      second.getTime()
    )
  ) {
    return 0;
  }

  const diff =
    Math.abs(
      first.getTime() -
        second.getTime()
    );

  const hours =
    diff /
    (1000 * 60 * 60);

  if (
    hours <= 6
  ) {
    return 1;
  }

  if (
    hours <= 24
  ) {
    return 0.7;
  }

  if (
    hours <= 72
  ) {
    return 0.3;
  }

  return 0;
}

function tokenize(
  value: string
): string[] {
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
      " "
    )
    .split(
      /\s+/
    )
    .filter(
      (word) =>
        word.length >= 3 &&
        !STOP_WORDS.has(
          word
        )
    );
}

const STOP_WORDS =
  new Set([
    "les",
    "des",
    "une",
    "dans",
    "avec",
    "pour",
    "sur",
    "par",
    "est",
    "son",
    "ses",
    "mais",
    "plus",
    "apres",
    "avant",
    "cette",
    "cela",
    "etre",
    "sont",
    "qui",
    "que",
    "du",
    "de",
    "le",
    "la",
    "un",
    "et",
    "ou",
    "au",
    "aux",
    "en",
    "a",
    "ce",
    "se",
    "ne",
    "pas",
    "une",
  ]);

function areSimilarTitles(
  a: string,
  b: string
): boolean {
  return (
    titleSimilarity(
      a,
      b
    ) >=
    0.62
  );
}

function isRelevantToPSG(
  title: string,
  description: string
): boolean {
  const text =
    `${title} ${description}`.toLowerCase();

  const directSignals =
    [
      "psg",
      "paris saint-germain",
      "paris sg",
      "paris saint germain",
      "parisien",
      "parisiens",
    ];

  if (
    directSignals.some(
      (signal) =>
        text.includes(
          signal
        )
    )
  ) {
    return true;
  }

  const psgPlayers =
    [
      "dembélé",
      "dembele",
      "doué",
      "doue",
      "barcola",
      "hakimi",
      "vitinha",
      "marquinhos",
      "nuno mendes",
      "kvaratskhelia",
      "joao neves",
      "pacho",
      "fabián ruiz",
      "fabian ruiz",
      "ferran torres",
    ];

  const psgContexts =
    [
      "ligue des champions",
      "champions league",
      "ligue 1",
      "ballon d'or",
      "ballon dor",
    ];

  const playerSignal =
    psgPlayers.some(
      (player) =>
        text.includes(
          player
        )
    );

  const contextSignal =
    psgContexts.some(
      (context) =>
        text.includes(
          context
        )
    );

  return (
    playerSignal &&
    contextSignal
  );
}

function slugify(
  value: string
): string {
  return value
    .toString()
    .normalize(
      "NFD"
    )
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
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
