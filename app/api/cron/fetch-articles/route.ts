import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

type RSSItem = {
  title: string;
  link: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
  source: string;
};

type EnrichedSource = {
  source: string;
  title: string;
  url: string;
  description: string;
  enrichedContent?: string;
  publishedAt?: string;
};

type GeneratedArticle = {
  title: string;
  excerpt: string;
  content: string;
  seoTitle: string;
  seoDescription: string;
};

type StoryCluster = {
  items: RSSItem[];
};

type EnrichmentResult = {
  sources: EnrichedSource[];
  pagesFetched: number;
  pagesFailed: number;
  enrichedCharacters: number;
};

type ProcessResult = {
  outcome: string;
  detail?: string;
  sources?: string[];
  pages?: number;
  enriched?: number;
};

export async function GET(request: Request) {
  const startedAt = Date.now();

  try {
    const cronSecret = process.env.CRON_SECRET;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!cronSecret) {
      return NextResponse.json(
        {
          error: "CRON_SECRET manquant",
        },
        { status: 500 },
      );
    }

    if (!geminiApiKey) {
      return NextResponse.json(
        {
          error: "GEMINI_API_KEY manquant",
        },
        { status: 500 },
      );
    }

    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        {
          error: "Unauthorized",
        },
        { status: 401 },
      );
    }

    const articlesCreatedToday = await getArticlesCreatedToday();

    const remainingDailyTarget = Math.max(
      0,
      DAILY_TARGET - articlesCreatedToday,
    );

    if (remainingDailyTarget <= 0) {
      return NextResponse.json({
        checked: 0,
        newItems: 0,
        clusters: 0,
        candidateClusters: 0,
        processedClusters: 0,
        deferred: 0,
        created: 0,
        skipped: 0,
        articlesCreatedToday,
        dailyTarget: DAILY_TARGET,
        remainingDailyTarget: 0,
        dailyTargetReached: true,
        sourcesOk: [],
        sources: RSS_FEEDS.map((feed) => feed.name),
        duplicates: 0,
        fusion: true,
        optimized: true,
        enrichment: true,
        simplified: true,
        unlimitedDailyCap: true,
        diagnostics: {
          geminiCalls: 0,
          geminiSuccess: 0,
          geminiErrors: [],
          invalidJson: 0,
          tooShort: 0,
          tooShortAfterRetry: 0,
          slugErrors: 0,
          createErrors: 0,
          rssErrors: [],
          sourcePagesFetched: 0,
          sourcePagesFailed: 0,
          enrichedCharacters: 0,
          sourcePageErrors: [],
          clusters: [],
        },
        elapsedMs: Date.now() - startedAt,
      });
    }

    const rssResults = await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        try {
          const items = await parseRSS(feed);

          return {
            feed,
            items,
            error: null as string | null,
          };
        } catch (error) {
          return {
            feed,
            items: [] as RSSItem[],
            error: getErrorMessage(error),
          };
        }
      }),
    );

    const rssErrors = rssResults
      .filter((result) => result.error)
      .map((result) => `${result.feed.name}: ${result.error}`);

    const sourcesOk = rssResults
      .filter((result) => !result.error)
      .map((result) => result.feed.name);

    const allItems = rssResults.flatMap((result) => result.items);

    const checked = allItems.length;

    const relevantItems = allItems.filter((item) =>
      isRelevantPSG(item),
    );

    const deduplicatedItems = deduplicateItems(relevantItems);

    const duplicates =
      relevantItems.length - deduplicatedItems.length;

    const recentArticles = await prisma.article.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 150,
      select: {
        id: true,
        title: true,
        sourceUrl: true,
        slug: true,
      },
    });

    const newItems = deduplicatedItems.filter(
      (item) => !isAlreadyStored(item, recentArticles),
    );

    const clusters = buildSimpleClusters(newItems);

    const candidateClusters = clusters.filter(
      (cluster) => cluster.items.length > 0,
    );

    const maxClusters = Math.min(
      MAX_NEW_ARTICLES_PER_RUN,
      remainingDailyTarget,
    );

    const prioritizedClusters = [...candidateClusters]
      .sort(clusterPriority)
      .slice(0, maxClusters);

    const deferred = Math.max(
      0,
      candidateClusters.length - prioritizedClusters.length,
    );

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

    const clusterDiagnostics: Array<Record<string, unknown>> = [];

    for (
      let index = 0;
      index < prioritizedClusters.length;
      index++
    ) {
      const cluster = prioritizedClusters[index];

      const result = await processCluster(cluster, {
        onGeminiCall: () => {
          geminiCalls++;
        },
        onGeminiSuccess: () => {
          geminiSuccess++;
        },
        onInvalidJson: () => {
          invalidJson++;
        },
        onTooShort: () => {
          tooShort++;
        },
        onTooShortAfterRetry: () => {
          tooShortAfterRetry++;
        },
        onSlugError: () => {
          slugErrors++;
        },
        onCreateError: () => {
          createErrors++;
        },
        onGeminiError: (message) => {
          geminiErrors.push(message);
        },
        onSourcePageFetched: () => {
          sourcePagesFetched++;
        },
        onSourcePageFailed: (message) => {
          sourcePagesFailed++;
          sourcePageErrors.push(message);
        },
        onEnrichedCharacters: (count) => {
          enrichedCharacters += count;
        },
      });

      if (result.outcome === "created") {
        created++;
      } else {
        skipped++;
      }

      clusterDiagnostics.push({
        cluster: index + 1,
        sources: result.sources || [
          ...new Set(
            cluster.items.map((item) => item.source),
          ),
        ],
        titles: cluster.items.map((item) => item.title),
        outcome: result.outcome,
        detail: result.detail,
      });
    }

    const finalArticlesCreatedToday =
      await getArticlesCreatedToday();

    const finalRemainingDailyTarget = Math.max(
      0,
      DAILY_TARGET - finalArticlesCreatedToday,
    );

    return NextResponse.json({
      checked,
      newItems: newItems.length,
      clusters: clusters.length,
      candidateClusters: candidateClusters.length,
      processedClusters: prioritizedClusters.length,
      deferred,
      created,
      skipped,
      articlesCreatedToday: finalArticlesCreatedToday,
      dailyTarget: DAILY_TARGET,
      remainingDailyTarget: finalRemainingDailyTarget,
      dailyTargetReached:
        finalRemainingDailyTarget <= 0,
      sourcesOk,
      sources: RSS_FEEDS.map((feed) => feed.name),
      duplicates,
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
        clusters: clusterDiagnostics,
      },
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error(
      "fetch-articles error:",
      error,
    );

    return NextResponse.json(
      {
        error: getErrorMessage(error),
        elapsedMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

async function processCluster(
  cluster: StoryCluster,
  callbacks: {
    onGeminiCall: () => void;
    onGeminiSuccess: () => void;
    onInvalidJson: () => void;
    onTooShort: () => void;
    onTooShortAfterRetry: () => void;
    onSlugError: () => void;
    onCreateError: () => void;
    onGeminiError: (message: string) => void;
    onSourcePageFetched: () => void;
    onSourcePageFailed: (message: string) => void;
    onEnrichedCharacters: (count: number) => void;
  },
): Promise<ProcessResult> {
  try {
    const enrichment = await enrichSources(
      cluster.items,
      callbacks,
    );

    if (!enrichment.sources.length) {
      return {
        outcome: "no_sources",
        detail: "Aucune source exploitable",
      };
    }

    const generated = await generateArticle(
      enrichment.sources,
      false,
      undefined,
      callbacks,
    );

    if (!generated) {
      return {
        outcome: "gemini_error",
        detail: `title=${
          cluster.items[0]?.title?.length || 0
        }`,
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

    let article = generated;
    let generatedWords = countWords(
      article.content,
    );

    if (generatedWords < MIN_ARTICLE_WORDS) {
      callbacks.onTooShort();

      console.log(
        `Article trop court (${generatedWords} mots), lancement de l'expansion Gemini...`,
      );

      const expanded = await generateArticle(
        enrichment.sources,
        true,
        {
          title: article.title,
          excerpt: article.excerpt,
          content: article.content,
        },
        callbacks,
      );

      if (expanded) {
        const expandedWords = countWords(
          expanded.content,
        );

        console.log(
          `Expansion Gemini : ${generatedWords} → ${expandedWords} mots`,
        );

        if (expandedWords > generatedWords) {
          article = expanded;
          generatedWords = expandedWords;
        }
      }
    }

    if (generatedWords < MIN_ARTICLE_WORDS) {
      callbacks.onTooShortAfterRetry();

      return {
        outcome: "too_short_after_retry",
        detail: `title=${article.title.length}, words=${generatedWords}, excerpt=${article.excerpt.length}`,
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

    article.content = cleanArticleContent(
      article.content,
    );

    article.content = addBasicStructure(
      article.content,
    );

    article.content = trimToWords(
      article.content,
      MAX_ARTICLE_WORDS,
    );

    article.excerpt = cleanText(
      article.excerpt,
    );

    article.title = cleanText(
      article.title,
    );

    article.seoTitle = cleanText(
      article.seoTitle,
    );

    article.seoDescription = cleanText(
      article.seoDescription,
    );

    if (
      !article.title ||
      !article.content
    ) {
      return {
        outcome: "invalid_article",
        detail: "Titre ou contenu vide",
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

    const duplicateTitle =
      recentTitleDuplicate(
        article.title,
        cluster.items,
      );

    if (duplicateTitle) {
      return {
        outcome: "duplicate_title",
        detail: `title=${article.title}`,
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

    let slug: string;

    try {
      slug = await makeUniqueSlug(
        article.title,
      );
    } catch (error) {
      callbacks.onSlugError();

      return {
        outcome: "slug_error",
        detail: getErrorMessage(error),
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

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
          sourceUrl:
            cluster.items[0]?.link ||
            enrichment.sources[0]?.url ||
            null,
        },
      });
    } catch (error) {
      callbacks.onCreateError();

      return {
        outcome: "create_error",
        detail: getErrorMessage(error),
        sources: enrichment.sources.map(
          (source) => source.source,
        ),
        pages: enrichment.pagesFetched,
        enriched: enrichment.enrichedCharacters,
      };
    }

    callbacks.onGeminiSuccess();

    return {
      outcome: "created",
      detail: `words=${countWords(
        article.content,
      )}, sources=${
        enrichment.sources.length
      }, pages=${
        enrichment.pagesFetched
      }, enriched=${
        enrichment.enrichedCharacters
      }`,
      sources: enrichment.sources.map(
        (source) => source.source,
      ),
      pages: enrichment.pagesFetched,
      enriched: enrichment.enrichedCharacters,
    };
  } catch (error) {
    return {
      outcome: "error",
      detail: getErrorMessage(error),
    };
  }
}

async function enrichSources(
  items: RSSItem[],
  callbacks: {
    onSourcePageFetched: () => void;
    onSourcePageFailed: (
      message: string,
    ) => void;
    onEnrichedCharacters: (
      count: number,
    ) => void;
  },
): Promise<EnrichmentResult> {
  const selected = [...items]
    .sort(
      (a, b) =>
        sourcePriority(b) -
        sourcePriority(a),
    )
    .slice(
      0,
      MAX_SOURCES_PER_ARTICLE,
    );

  const results = await Promise.all(
    selected.map(async (item) => {
      const base: EnrichedSource = {
        source: item.source,
        title: cleanText(item.title),
        url: cleanUrl(item.link),
        description: cleanText(
          item.contentSnippet ||
            item.content ||
            "",
        ),
        publishedAt: item.pubDate,
      };

      if (!shouldFetchSourcePage(item)) {
        return {
          source: base,
          fetched: false,
          failed: false,
          chars: base.description.length,
        };
      }

      try {
        const response =
          await fetchWithTimeout(
            cleanUrl(item.link),
            SOURCE_TIMEOUT_MS,
          );

        if (!response.ok) {
          const message =
            `${item.source}: HTTP ${response.status} ${response.statusText}`;

          callbacks.onSourcePageFailed(
            message,
          );

          return {
            source: base,
            fetched: false,
            failed: true,
            chars: base.description.length,
          };
        }

        const html =
          await response.text();

        const text =
          extractPageText(html);

        const enriched = cleanText(
          text.slice(
            0,
            MAX_SOURCE_PAGE_CHARS,
          ),
        );

        const source: EnrichedSource =
          {
            ...base,
            enrichedContent:
              enriched ||
              base.description,
          };

        callbacks.onSourcePageFetched();

        callbacks.onEnrichedCharacters(
          source.enrichedContent
            ?.length || 0,
        );

        return {
          source,
          fetched: true,
          failed: false,
          chars:
            source.enrichedContent
              ?.length || 0,
        };
      } catch (error) {
        const message =
          `${item.source}: ${getErrorMessage(error)}`;

        callbacks.onSourcePageFailed(
          message,
        );

        return {
          source: base,
          fetched: false,
          failed: true,
          chars: base.description.length,
        };
      }
    }),
  );

  return {
    sources: results.map(
      (result) => result.source,
    ),
    pagesFetched: results.filter(
      (result) => result.fetched,
    ).length,
    pagesFailed: results.filter(
      (result) => result.failed,
    ).length,
    enrichedCharacters:
      results.reduce(
        (total, result) =>
          total + result.chars,
        0,
      ),
  };
}

function shouldFetchSourcePage(
  item: RSSItem,
): boolean {
  if (!item.link) {
    return false;
  }

  if (
    !/^https?:\/\//i.test(
      item.link,
    )
  ) {
    return false;
  }

  if (
    item.link.includes(
      "news.google.com",
    )
  ) {
    return false;
  }

  return true;
}

async function generateArticle(
  sources: EnrichedSource[],
  expandExisting = false,
  existingArticle?: {
    title: string;
    excerpt: string;
    content: string;
  },
  callbacks?: {
    onGeminiCall: () => void;
    onGeminiSuccess: () => void;
    onInvalidJson: () => void;
    onGeminiError: (
      message: string,
    ) => void;
  },
): Promise<GeneratedArticle | null> {
  const sourceMaterial =
    sources
      .map((source, index) => {
        return `
===== SOURCE ${index + 1} =====
Source : ${source.source}
Titre : ${source.title}
URL : ${source.url}
Date : ${
          source.publishedAt ||
          "Non précisée"
        }

CONTENU RSS :
${
  source.description || ""
}

CONTENU ENRICHI :
${
  source.enrichedContent ||
  source.description ||
  ""
}
`;
      })
      .join("\n\n");

  const expansionContext =
    expandExisting &&
    existingArticle
      ? `
===== BROUILLON EXISTANT À AMÉLIORER =====

Titre :
${existingArticle.title}

Extrait :
${existingArticle.excerpt}

Article :
${existingArticle.content}

INSTRUCTION IMPORTANTE :

Le brouillon ci-dessus est insuffisant en longueur ou en profondeur.

Tu dois LE CONSERVER comme base et l'enrichir fortement.

NE RECOMMENCE PAS L'ARTICLE DEPUIS ZÉRO.

Tu dois :

- conserver les faits déjà présents lorsqu'ils sont corrects ;
- ajouter les informations factuelles présentes dans les sources ;
- développer les explications et le contexte ;
- ajouter les informations sur la date, l'heure, le stade, la diffusion TV, les compositions, les absences, les blessures, les déclarations, le contexte sportif ou tout autre élément réellement présent dans les sources ;
- supprimer les répétitions ;
- améliorer les transitions ;
- produire un véritable article de presse sportive ;
- viser 600 à 800 mots ;
- ne jamais inventer de faits.

Chaque ajout doit être justifié par les sources.
`
      : "";

  const prompt = `
Tu es le rédacteur en chef de PSG Direct, un média français spécialisé exclusivement dans le Paris Saint-Germain.

Ta mission est de rédiger UN ARTICLE DE PRESSE SPORTIVE ORIGINAL à partir des sources fournies.

${expansionContext}

===== SOURCES DISPONIBLES =====

${sourceMaterial}

===== RÈGLES ÉDITORIALES ABSOLUES =====

1. Utilise uniquement les informations réellement présentes dans les sources.

2. Tu ne dois JAMAIS inventer :

- une date ;
- une heure ;
- un score ;
- une composition ;
- un joueur absent ;
- une blessure ;
- une suspension ;
- une chaîne TV ;
- un stade ;
- un arbitre ;
- une déclaration ;
- une statistique ;
- une information de transfert ;
- ou toute autre information factuelle.

3. Si une information n'est pas présente dans les sources, ne l'invente pas.

4. Lorsque plusieurs sources parlent du même événement, fusionne leurs informations en UN SEUL article.

5. Ne fais jamais une simple succession de résumés des sources.

6. L'article doit avoir une vraie structure journalistique.

7. Privilégie les faits concrets aux phrases génériques.

8. Lorsque plusieurs sources confirment la même information, tu peux la présenter comme un fait établi.

9. Lorsque seule une source rapporte une information importante, attribue-la clairement lorsque nécessaire.

10. Ne répète pas inutilement les mêmes informations.

11. Ne fais aucun commentaire sur ton processus de rédaction.

12. Ne parle pas de toi.

13. Ne mentionne jamais que tu es une IA.

14. Le texte doit être en français naturel, journalistique et fluide.

15. L'article doit idéalement contenir entre ${TARGET_ARTICLE_WORDS} et 800 mots.

16. Si les sources contiennent suffisamment d'informations, exploite-les réellement afin d'atteindre cette longueur.

17. Ne remplis jamais artificiellement l'article avec des phrases vagues pour atteindre le nombre de mots.

18. Chaque paragraphe doit apporter une information ou un contexte utile.

19. Ne transforme pas une hypothèse en certitude.

20. Ne présente pas une probable composition comme une composition officielle.

21. Ne présente pas une information annoncée comme définitive si les sources indiquent seulement qu'elle est envisagée.

22. Si les sources divergent, indique clairement la divergence au lieu de choisir arbitrairement une version.

23. Les informations pratiques comme l'heure, la chaîne, le stade ou la date doivent uniquement être ajoutées lorsqu'elles sont réellement disponibles.

24. Les sources peuvent contenir plusieurs articles concernant le même événement. Regroupe-les et utilise les informations complémentaires de chaque source.

25. Donne la priorité aux informations précises et vérifiables : noms de joueurs, adversaire, compétition, date, heure, stade, chaîne, composition, absences, blessures, déclarations, statistiques et contexte.

26. Si une information importante apparaît dans une seule source mais que cette source est clairement identifiée, tu peux l'utiliser en l'attribuant.

27. Ne transforme jamais une information provenant d'une source en fait confirmé par plusieurs sources si elle n'est confirmée que par une seule.

28. Ne cite jamais une information provenant d'une source qui n'est pas réellement présente dans le matériel fourni.

===== FORMAT DE RÉPONSE OBLIGATOIRE =====

Retourne UNIQUEMENT un objet JSON valide avec exactement ces champs :

{
  "title": "titre de l'article",
  "excerpt": "résumé de 2 à 3 phrases",
  "content": "article complet",
  "seoTitle": "titre SEO",
  "seoDescription": "description SEO"
}

Aucun Markdown autour du JSON.
Aucun texte avant le JSON.
Aucun texte après le JSON.
`;

  try {
    callbacks?.onGeminiCall();

    const result =
      await callGemini(prompt);

    if (!result) {
      return null;
    }

    const parsed =
      parseGeminiJson(result);

    if (
      !parsed ||
      !isValidGeminiArticle(
        parsed,
      )
    ) {
      callbacks?.onInvalidJson();
      return null;
    }

    return normalizeArticle(
      parsed,
    );
  } catch (error) {
    const message =
      getErrorMessage(error);

    callbacks?.onGeminiError(
      message,
    );

    console.error(
      "Gemini generation error:",
      message,
    );

    return null;
  }
}

async function callGemini(
  prompt: string,
): Promise<string | null> {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY manquant",
    );
  }

  const models = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
  ];

  let lastError: Error | null =
    null;

  for (const model of models) {
    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          GEMINI_TIMEOUT_MS,
        );

      try {
        const response =
          await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
                  temperature: 0.25,
                  responseMimeType:
                    "application/json",
                },
              }),
              signal:
                controller.signal,
            },
          );

        if (!response.ok) {
          const text =
            await response.text();

          throw new Error(
            `Gemini HTTP ${response.status}: ${text.slice(
              0,
              500,
            )}`,
          );
        }

        const data =
          await response.json();

        const text =
          data?.candidates?.[0]
            ?.content?.parts?.[0]
            ?.text;

        if (
          !text ||
          typeof text !==
            "string"
        ) {
          throw new Error(
            "Réponse Gemini vide",
          );
        }

        return text;
      } finally {
        clearTimeout(
          timeout,
        );
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(
              getErrorMessage(
                error,
              ),
            );

      console.error(
        `Gemini model ${model} failed:`,
        lastError.message,
      );
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function parseGeminiJson(
  raw: string,
): GeneratedArticle | null {
  try {
    const direct =
      JSON.parse(raw);

    if (
      isValidGeminiArticle(
        direct,
      )
    ) {
      return direct;
    }
  } catch {
    // Continue.
  }

  const extracted =
    extractFirstJsonObject(
      raw,
    );

  if (!extracted) {
    return null;
  }

  try {
    const parsed =
      JSON.parse(extracted);

    if (
      isValidGeminiArticle(
        parsed,
      )
    ) {
      return parsed;
    }
  } catch {
    // Continue.
  }

  try {
    const repaired =
      repairJsonString(
        extracted,
      );

    const parsed =
      JSON.parse(repaired);

    if (
      isValidGeminiArticle(
        parsed,
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
  value: unknown,
): value is GeneratedArticle {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return false;
  }

  const article =
    value as Record<
      string,
      unknown
    >;

  return (
    typeof article.title ===
      "string" &&
    typeof article.excerpt ===
      "string" &&
    typeof article.content ===
      "string" &&
    typeof article.seoTitle ===
      "string" &&
    typeof article.seoDescription ===
      "string" &&
    article.title.trim()
      .length > 10 &&
    article.content.trim()
      .length > 100
  );
}

function extractFirstJsonObject(
  text: string,
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
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (
      char === "}"
    ) {
      depth--;

      if (depth === 0) {
        return text.slice(
          start,
          i + 1,
        );
      }
    }
  }

  return null;
}

function repairJsonString(
  text: string,
): string {
  let repaired =
    text.trim();

  repaired = repaired
    .replace(
      /^\uFEFF/,
      "",
    )
    .replace(
      /^```json\s*/i,
      "",
    )
    .replace(
      /^```\s*/i,
      "",
    )
    .replace(
      /\s*```$/i,
      "",
    )
    .trim();

  repaired =
    repaired.replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      " ",
    );

  return repaired;
}

function normalizeArticle(
  article: GeneratedArticle,
): GeneratedArticle {
  const content =
    cleanArticleContent(
      article.content,
    );

  return {
    title: cleanText(
      article.title,
    ),
    excerpt: cleanText(
      article.excerpt,
    ),
    content,
    seoTitle: cleanText(
      article.seoTitle,
    ),
    seoDescription:
      cleanText(
        article.seoDescription,
      ),
  };
}

function addBasicStructure(
  content: string,
): string {
  const cleaned =
    cleanArticleContent(
      content,
    );

  if (!cleaned) {
    return "";
  }

  const paragraphs =
    cleaned
      .split(/\n{2,}/)
      .map(
        (paragraph) =>
          paragraph.trim(),
      )
      .filter(Boolean);

  if (
    paragraphs.length <= 1
  ) {
    return cleaned;
  }

  return paragraphs.join(
    "\n\n",
  );
}

function trimToWords(
  text: string,
  maxWords: number,
): string {
  const words =
    text
      .split(/\s+/)
      .filter(Boolean);

  if (
    words.length <= maxWords
  ) {
    return text;
  }

  return (
    words
      .slice(0, maxWords)
      .join(" ") + "..."
  );
}

function buildSimpleClusters(
  items: RSSItem[],
): StoryCluster[] {
  const clusters: StoryCluster[] =
    [];

  /*
   * Un titre qui parle explicitement
   * de plusieurs adversaires ou plusieurs
   * matchs ne doit pas servir à fusionner
   * plusieurs événements.
   *
   * Exemple :
   * PSG/Monaco & PSG/Bratislava
   */
  const safeItems =
    items.filter((item) => {
      const opponents =
        extractAllOpponents(
          normalizeForComparison(
            item.title,
          ),
        );

      return (
        opponents.length <= 1
      );
    });

  const sorted = [
    ...safeItems,
  ].sort(
    (a, b) =>
      sourcePriority(b) -
      sourcePriority(a),
  );

  for (const item of sorted) {
    let bestCluster:
      | StoryCluster
      | null = null;

    let bestSimilarity = 0;

    for (
      const cluster of clusters
    ) {
      const similarity =
        similarityToCluster(
          item,
          cluster,
        );

      if (
        similarity >
        bestSimilarity
      ) {
        bestSimilarity =
          similarity;

        bestCluster =
          cluster;
      }
    }

    if (
      bestCluster &&
      bestSimilarity >= 0.42
    ) {
      bestCluster.items.push(
        item,
      );
    } else {
      clusters.push({
        items: [item],
      });
    }
  }

  return clusters;
}

function similarityToCluster(
  item: RSSItem,
  cluster: StoryCluster,
): number {
  let best = 0;

  for (
    const clusterItem of
      cluster.items
  ) {
    const similarity =
      simpleStorySimilarity(
        item,
        clusterItem,
      );

    if (
      similarity > best
    ) {
      best = similarity;
    }
  }

  return best;
}

function simpleStorySimilarity(
  a: RSSItem,
  b: RSSItem,
): number {
  const titleA =
    normalizeForComparison(
      a.title,
    );

  const titleB =
    normalizeForComparison(
      b.title,
    );

  const opponentsA =
    extractAllOpponents(
      titleA,
    );

  const opponentsB =
    extractAllOpponents(
      titleB,
    );

  if (
    opponentsA.length > 1 ||
    opponentsB.length > 1
  ) {
    return 0;
  }

  if (
    opponentsA.length &&
    opponentsB.length &&
    opponentsA[0] !==
      opponentsB[0]
  ) {
    return 0;
  }

  const eventA =
    extractEvent(titleA);

  const eventB =
    extractEvent(titleB);

  if (
    eventA &&
    eventB &&
    eventA !== eventB
  ) {
    return 0;
  }

  const similarity =
    titleSimilarity(
      titleA,
      titleB,
    );

  const tokensA =
    meaningfulTokens(
      titleA,
    );

  const tokensB =
    meaningfulTokens(
      titleB,
    );

  const common =
    tokensA.filter(
      (token) =>
        tokensB.includes(token),
    );

  const tokenScore =
    common.length /
    Math.max(
      1,
      Math.min(
        tokensA.length,
        tokensB.length,
      ),
    );

  let score =
    similarity * 0.65 +
    tokenScore * 0.35;

  if (
    opponentsA.length &&
    opponentsB.length &&
    opponentsA[0] ===
      opponentsB[0]
  ) {
    score += 0.18;
  }

  if (
    eventA &&
    eventB &&
    eventA === eventB
  ) {
    score += 0.08;
  }

  return Math.min(
    1,
    score,
  );
}

function extractAllOpponents(
  title: string,
): string[] {
  const normalized =
    normalizeForComparison(
      title,
    );

  if (
    normalized.includes(
      "bratislava",
    ) ||
    normalized.includes(
      "slovan",
    )
  ) {
    return [
      "slovan bratislava",
    ];
  }

  const opponents =
    new Set<string>();

  const patterns = [
    /psg\s*[-–—/]\s*([a-z0-9àâäéèêëîïôöùûüç' .]+)/i,
    /paris saint-germain\s*[-–—/]\s*([a-z0-9àâäéèêëîïôöùûüç' .]+)/i,
    /([a-z0-9àâäéèêëîïôöùûüç' .]+)\s*[-–—/]\s*psg/i,
    /([a-z0-9àâäéèêëîïôöùûüç' .]+)\s*[-–—/]\s*paris saint-germain/i,
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      normalized.match(
        pattern,
      );

    if (match?.[1]) {
      const opponent =
        cleanOpponent(
          match[1],
        );

      if (opponent) {
        opponents.add(
          opponent,
        );
      }
    }
  }

  const slashMatches =
    normalized.match(
      /\bpsg\s*\/\s*([a-z0-9àâäéèêëîïôöùûüç' .]+)/gi,
    );

  if (slashMatches) {
    for (
      const match of
        slashMatches
    ) {
      const opponent =
        cleanOpponent(
          match.replace(
            /^psg\s*\/\s*/i,
            "",
          ),
        );

      if (opponent) {
        opponents.add(
          opponent,
        );
      }
    }
  }

  return [
    ...opponents,
  ];
}

function extractOpponent(
  title: string,
): string {
  return (
    extractAllOpponents(
      title,
    )[0] || ""
  );
}

function cleanOpponent(
  value: string,
): string {
  let opponent =
    value
      .replace(
        /\b(à quelle heure|sur quelle chaîne|quelle chaîne|voir le match|match|direct|live|pronostics|pronostic|compositions?|composition|les notes|notes|pour|face à|contre|avant|apres|après|et|du|de|la|le|un|une|en|ligue|champions|league|football)\b.*$/i,
        "",
      )
      .trim();

  opponent =
    opponent
      .replace(
        /[?!:;,.\-–—]+$/g,
        "",
      )
      .trim();

  return opponent.length >= 3
    ? opponent
    : "";
}

function extractEvent(
  title: string,
): string {
  const normalized =
    normalizeForComparison(
      title,
    );

  if (
    normalized.includes(
      "composition",
    ) ||
    normalized.includes(
      "compose",
    ) ||
    normalized.includes(
      "compositions",
    )
  ) {
    return "composition";
  }

  if (
    normalized.includes(
      "absent",
    ) ||
    normalized.includes(
      "forfait",
    ) ||
    normalized.includes(
      "blessure",
    ) ||
    normalized.includes(
      "blesse",
    )
  ) {
    return "absence";
  }

  if (
    normalized.includes(
      "arbitre",
    )
  ) {
    return "arbitre";
  }

  if (
    normalized.includes(
      "heure",
    ) ||
    normalized.includes(
      "chaine",
    ) ||
    normalized.includes(
      "tv",
    ) ||
    normalized.includes(
      "diffusion",
    )
  ) {
    return "diffusion";
  }

  if (
    normalized.includes(
      "maillot",
    ) ||
    normalized.includes(
      "equipement",
    )
  ) {
    return "maillot";
  }

  if (
    normalized.includes(
      "parc des princes",
    ) ||
    normalized.includes(
      "travaux",
    )
  ) {
    return "stade";
  }

  if (
    normalized.includes(
      "podcast",
    )
  ) {
    return "podcast";
  }

  if (
    normalized.includes(
      "conference",
    ) ||
    normalized.includes(
      "presse",
    )
  ) {
    return "conference";
  }

  return "general";
}

function deduplicateItems(
  items: RSSItem[],
): RSSItem[] {
  const result: RSSItem[] =
    [];

  const seenUrls =
    new Set<string>();

  const seenTitles =
    new Set<string>();

  for (
    const item of items
  ) {
    const url =
      normalizeUrl(
        item.link,
      );

    const title =
      normalizeForComparison(
        item.title,
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
      seenTitles.add(
        title,
      );
    }

    result.push(item);
  }

  return result;
}

function isAlreadyStored(
  item: RSSItem,
  recentArticles: Array<{
    id: number;
    title: string;
    sourceUrl: string | null;
    slug: string;
  }>,
): boolean {
  const itemUrl =
    normalizeUrl(
      item.link,
    );

  const itemTitle =
    normalizeForComparison(
      item.title,
    );

  for (
    const article of
      recentArticles
  ) {
    if (
      itemUrl &&
      article.sourceUrl &&
      normalizeUrl(
        article.sourceUrl,
      ) === itemUrl
    ) {
      return true;
    }

    const storedTitle =
      normalizeForComparison(
        article.title,
      );

    if (
      itemTitle &&
      storedTitle &&
      titleSimilarity(
        itemTitle,
        storedTitle,
      ) >= 0.82
    ) {
      return true;
    }
  }

  return false;
}

function recentTitleDuplicate(
  title: string,
  clusterItems: RSSItem[],
): boolean {
  const normalizedTitle =
    normalizeForComparison(
      title,
    );

  if (!normalizedTitle) {
    return true;
  }

  for (
    const item of
      clusterItems
  ) {
    const sourceTitle =
      normalizeForComparison(
        item.title,
      );

    if (
      titleSimilarity(
        normalizedTitle,
        sourceTitle,
      ) >= 0.95
    ) {
      return false;
    }
  }

  return false;
}

function isRelevantPSG(
  item: RSSItem,
): boolean {
  const text =
    normalizeForComparison(
      `${item.title} ${
        item.contentSnippet ||
        ""
      } ${
        item.content || ""
      }`,
    );

  const hasPSG =
    text.includes("psg") ||
    text.includes(
      "paris saint-germain",
    ) ||
    text.includes(
      "paris saint germain",
    );

  return hasPSG;
}

/**
 * Parse RSS/Atom XML nativement.
 *
 * Aucun package externe nécessaire.
 */
async function parseRSS(
  feed: {
    name: string;
    url: string;
  },
): Promise<RSSItem[]> {
  const xml =
    await fetchRSSXml(
      feed.url,
    );

  const items: RSSItem[] =
    [];

  const rssItemMatches = [
    ...xml.matchAll(
      /<item\b[^>]*>([\s\S]*?)<\/item>/gi,
    ),
  ];

  /*
   * Si le flux est Atom plutôt que RSS,
   * on utilise <entry>.
   */
  const atomEntryMatches =
    rssItemMatches.length ===
    0
      ? [
          ...xml.matchAll(
            /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi,
          ),
        ]
      : [];

  const blocks =
    rssItemMatches.length >
    0
      ? rssItemMatches.map(
          (match) =>
            match[1],
        )
      : atomEntryMatches.map(
          (match) =>
            match[1],
        );

  for (
    const block of blocks
      .slice(
        0,
        MAX_ITEMS_PER_SOURCE,
      )
  ) {
    const title =
      extractXMLTag(
        block,
        "title",
      );

    let link =
      extractXMLTag(
        block,
        "link",
      );

    /*
     * Atom utilise souvent :
     * <link href="..." />
     */
    if (!link) {
      const atomLink =
        block.match(
          /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i,
        );

      if (atomLink?.[1]) {
        link = atomLink[1];
      }
    }

    /*
     * Certains flux utilisent guid
     * comme URL lorsque link est absent.
     */
    if (!link) {
      link =
        extractXMLTag(
          block,
          "guid",
        );
    }

    if (!title || !link) {
      continue;
    }

    const description =
      extractXMLTag(
        block,
        "description",
      );

    const contentEncoded =
      extractXMLTag(
        block,
        "content:encoded",
      );

    const summary =
      extractXMLTag(
        block,
        "summary",
      );

    const content =
      contentEncoded ||
      description ||
      summary ||
      "";

    const pubDate =
      extractXMLTag(
        block,
        "pubDate",
      ) ||
      extractXMLTag(
        block,
        "published",
      ) ||
      extractXMLTag(
        block,
        "updated",
      ) ||
      undefined;

    const cleanedLink =
      decodeXmlText(
        link,
      ).trim();

    items.push({
      title:
        decodeXmlText(
          title,
        ).trim(),
      link: cleanedLink,
      pubDate: pubDate
        ? decodeXmlText(
            pubDate,
          ).trim()
        : undefined,
      content:
        decodeXmlText(
          content,
        ),
      contentSnippet:
        cleanText(
          content,
        ),
      source:
        feed.name,
    });
  }

  return items;
}

async function fetchRSSXml(
  url: string,
): Promise<string> {
  const response =
    await fetchWithTimeout(
      url,
      RSS_TIMEOUT_MS,
    );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

function extractXMLTag(
  xml: string,
  tag: string,
): string {
  const escapedTag =
    tag.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );

  const regex =
    new RegExp(
      `<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`,
      "i",
    );

  const match =
    regex.exec(xml);

  if (!match?.[1]) {
    return "";
  }

  return match[1]
    .replace(
      /^<!\[CDATA\[/i,
      "",
    )
    .replace(
      /\]\]>$/i,
      "",
    )
    .trim();
}

function decodeXmlText(
  text: string,
): string {
  if (!text) {
    return "";
  }

  return decodeHtmlEntities(
    text
      .replace(
        /^<!\[CDATA\[/i,
        "",
      )
      .replace(
        /\]\]>$/i,
        "",
      ),
  );
}

function extractPageText(
  html: string,
): string {
  let text = html;

  text =
    text.replace(
      /<script[\s\S]*?<\/script>/gi,
      " ",
    );

  text =
    text.replace(
      /<style[\s\S]*?<\/style>/gi,
      " ",
    );

  text =
    text.replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " ",
    );

  text =
    text.replace(
      /<svg[\s\S]*?<\/svg>/gi,
      " ",
    );

  text = stripHtml(
    text,
  );

  text =
    decodeHtmlEntities(
      text,
    );

  text =
    text
      .replace(
        /\s+/g,
        " ",
      )
      .trim();

  return text;
}

function clusterPriority(
  a: StoryCluster,
  b: StoryCluster,
): number {
  const priorityA =
    Math.max(
      ...a.items.map(
        (item) =>
          sourcePriority(
            item,
          ),
      ),
    ) +
    a.items.length * 10;

  const priorityB =
    Math.max(
      ...b.items.map(
        (item) =>
          sourcePriority(
            item,
          ),
      ),
    ) +
    b.items.length * 10;

  return (
    priorityB -
    priorityA
  );
}

function sourcePriority(
  itemOrSource:
    | RSSItem
    | string,
): number {
  const source =
    typeof itemOrSource ===
    "string"
      ? itemOrSource
      : itemOrSource.source;

  switch (source) {
    case "CulturePSG":
      return 100;

    case "RMC Sport":
      return 90;

    case "L'Équipe":
      return 90;

    case "Le Parisien":
      return 85;

    case "PSG.fr":
      return 85;

    case "Foot Mercato":
      return 75;

    case "Google News":
      return 60;

    default:
      return 40;
  }
}

function meaningfulTokens(
  text: string,
): string[] {
  const stopWords =
    new Set([
      "avec",
      "pour",
      "dans",
      "sur",
      "une",
      "des",
      "les",
      "aux",
      "est",
      "par",
      "pas",
      "plus",
      "apres",
      "avant",
      "entre",
      "face",
      "contre",
      "match",
      "psg",
      "paris",
      "saint",
      "germain",
      "football",
      "club",
      "cette",
      "sont",
      "sera",
      "etre",
      "être",
      "qui",
      "que",
      "du",
      "de",
      "la",
      "le",
      "et",
      "en",
      "au",
      "un",
      "a",
    ]);

  return normalizeForComparison(
    text,
  )
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 3 &&
        !stopWords.has(token),
    );
}

function titleSimilarity(
  a: string,
  b: string,
): number {
  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const tokensA =
    new Set(
      meaningfulTokens(a),
    );

  const tokensB =
    new Set(
      meaningfulTokens(b),
    );

  if (
    !tokensA.size ||
    !tokensB.size
  ) {
    return 0;
  }

  let intersection = 0;

  for (
    const token of tokensA
  ) {
    if (
      tokensB.has(token)
    ) {
      intersection++;
    }
  }

  const union =
    new Set([
      ...tokensA,
      ...tokensB,
    ]).size;

  return union
    ? intersection / union
    : 0;
}

function normalizeForComparison(
  text: string,
): string {
  return decodeHtmlEntities(
    cleanText(text),
  )
    .toLowerCase()
    .normalize("NFD")
    .replace(
      /[\u0300-\u036f]/g,
      "",
    )
    .replace(
      /œ/g,
      "oe",
    )
    .replace(
      /æ/g,
      "ae",
    )
    .replace(
      /[^\p{L}\p{N}\s]/gu,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function normalizeUrl(
  url:
    | string
    | null
    | undefined,
): string {
  if (!url) {
    return "";
  }

  return cleanUrl(url)
    .replace(
      /^https?:\/\//i,
      "",
    )
    .replace(
      /^www\./i,
      "",
    )
    .replace(
      /\/+$/,
      "",
    )
    .toLowerCase();
}

function cleanUrl(
  url:
    | string
    | null
    | undefined,
): string {
  if (!url) {
    return "";
  }

  try {
    const parsed =
      new URL(url);

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ];

    for (
      const param of
        trackingParams
    ) {
      parsed.searchParams.delete(
        param,
      );
    }

    return parsed.toString();
  } catch {
    return url.trim();
  }
}

function cleanText(
  text:
    | string
    | null
    | undefined,
): string {
  if (!text) {
    return "";
  }

  return decodeHtmlEntities(
    stripHtml(text),
  )
    .replace(
      /\u00a0/g,
      " ",
    )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function cleanArticleContent(
  content: string,
): string {
  if (!content) {
    return "";
  }

  let cleaned = content;

  cleaned =
    cleaned.replace(
      /```(?:html|markdown|text)?/gi,
      "",
    );

  cleaned =
    cleaned.replace(
      /```/g,
      "",
    );

  cleaned =
    cleaned.replace(
      /^\s*(article|contenu)\s*:\s*/i,
      "",
    );

  cleaned =
    stripHtml(
      cleaned,
    );

  cleaned =
    decodeHtmlEntities(
      cleaned,
    );

  cleaned =
    cleaned
      .replace(
        /\r\n/g,
        "\n",
      )
      .replace(
        /\r/g,
        "\n",
      );

  cleaned =
    cleaned
      .split("\n")
      .map(
        (line) =>
          line.trim(),
      )
      .filter(Boolean)
      .join("\n\n");

  return cleaned.trim();
}

function stripHtml(
  html: string,
): string {
  return html
    .replace(
      /<br\s*\/?>/gi,
      "\n",
    )
    .replace(
      /<\/p>/gi,
      "\n\n",
    )
    .replace(
      /<\/div>/gi,
      "\n",
    )
    .replace(
      /<\/li>/gi,
      "\n",
    )
    .replace(
      /<[^>]+>/g,
      " ",
    );
}

function decodeHtmlEntities(
  text: string,
): string {
  return text
    .replace(
      /&nbsp;/gi,
      " ",
    )
    .replace(
      /&amp;/gi,
      "&",
    )
    .replace(
      /&quot;/gi,
      '"',
    )
    .replace(
      /&#39;/gi,
      "'",
    )
    .replace(
      /&apos;/gi,
      "'",
    )
    .replace(
      /&lt;/gi,
      "<",
    )
    .replace(
      /&gt;/gi,
      ">",
    )
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(
          Number(code),
        ),
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(
            code,
            16,
          ),
        ),
    );
}

function countWords(
  text: string,
): number {
  if (!text) {
    return 0;
  }

  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

async function getArticlesCreatedToday(): Promise<number> {
  const startOfToday =
    getStartOfToday();

  return prisma.article.count(
    {
      where: {
        createdAt: {
          gte: startOfToday,
        },
      },
    },
  );
}

function getStartOfToday(): Date {
  const now =
    new Date();

  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
}

/**
 * Génération locale du slug.
 *
 * Remplace complètement slugify.
 */
function createBaseSlug(
  title: string,
): string {
  let slug =
    cleanText(title)
      .toLowerCase()
      .normalize("NFD")
      .replace(
        /[\u0300-\u036f]/g,
        "",
      )
      .replace(
        /œ/g,
        "oe",
      )
      .replace(
        /æ/g,
        "ae",
      )
      .replace(
        /&/g,
        " et ",
      )
      .replace(
        /[^a-z0-9]+/g,
        "-",
      )
      .replace(
        /^-+|-+$/g,
        "",
      )
      .replace(
        /-{2,}/g,
        "-",
      );

  /*
   * Évite un slug vide dans les cas
   * très particuliers.
   */
  if (!slug) {
    slug = "article-psg";
  }

  return slug;
}

async function makeUniqueSlug(
  title: string,
): Promise<string> {
  const baseSlug =
    createBaseSlug(title);

  if (!baseSlug) {
    throw new Error(
      "Impossible de générer un slug",
    );
  }

  let slug =
    baseSlug;

  let counter = 1;

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
        },
      );

    if (!existing) {
      return slug;
    }

    counter++;

    slug =
      `${baseSlug}-${counter}`;
  }
}

function getErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof Error
  ) {
    if (
      error.name ===
      "AbortError"
    ) {
      return "Timeout";
    }

    return error.message;
  }

  return String(error);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs,
    );

  try {
    return await fetch(
      url,
      {
        signal:
          controller.signal,
        headers: {
          "User-Agent":
            "PSG-Direct/1.0",
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
        },
        cache:
          "no-store",
      },
    );
  } finally {
    clearTimeout(
      timeout,
    );
  }
}
