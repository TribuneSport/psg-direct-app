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

const MAX_NEW_ARTICLES = 2;
const MAX_ITEMS_PER_SOURCE = 30;
const MAX_CLUSTERS_TO_PROCESS = 5;
const RSS_TIMEOUT_MS = 5000;
const GEMINI_TIMEOUT_MS = 12000;

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
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

export async function GET(req: NextRequest) {
  try {
    const secret = req.nextUrl.searchParams.get("secret");

    if (!CRON_SECRET) {
      return NextResponse.json(
        {
          error: "CRON_SECRET n'est pas configuré sur Vercel",
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
          error: "GEMINI_API_KEY n'est pas configurée sur Vercel",
        },
        { status: 500 }
      );
    }

    const sources = RSS_FEEDS.map((feed) => feed.name);
    const sourcesOk: string[] = [];

    /*
     * 1. Récupération des RSS en parallèle.
     *
     * L'ancienne version attendait chaque source l'une après l'autre.
     * Si une source était lente, tout le cron attendait.
     */
    const rssResults = await Promise.allSettled(
      RSS_FEEDS.map(async (feed) => {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
          controller.abort();
        }, RSS_TIMEOUT_MS);

        try {
          const response = await fetch(feed.url, {
            headers: {
              Accept:
                "application/rss+xml, application/xml, text/xml",
              "User-Agent": "PSG-Direct/1.0",
            },
            cache: "no-store",
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(
              `HTTP ${response.status} ${response.statusText}`
            );
          }

          const xml = await response.text();
          const items = parseRSS(xml);

          return {
            feed,
            items,
          };
        } finally {
          clearTimeout(timeout);
        }
      })
    );

    const allItems: FeedItem[] = [];

    for (const result of rssResults) {
      if (result.status !== "fulfilled") {
        console.error("Erreur RSS:", result.reason);
        continue;
      }

      const { feed, items } = result.value;

      if (items.length > 0) {
        sourcesOk.push(feed.name);
      }

      /*
       * On ne garde que les éléments les plus récents du flux.
       * Cela limite fortement le nombre de calculs de similarité.
       */
      const limitedItems = [...items]
        .sort((a, b) => {
          const dateA = a.publishedAt
            ? new Date(a.publishedAt).getTime()
            : 0;

          const dateB = b.publishedAt
            ? new Date(b.publishedAt).getTime()
            : 0;

          return dateB - dateA;
        })
        .slice(0, MAX_ITEMS_PER_SOURCE);

      for (const item of limitedItems) {
        const title = cleanText(item.title);
        const description = cleanText(item.description);

        if (!title || !item.url) {
          continue;
        }

        if (!isRelevantToPSG(title, description)) {
          continue;
        }

        allItems.push({
          source: feed.name,
          priority: feed.priority,
          title,
          description,
          url: item.url,
          publishedAt: item.publishedAt,
        });
      }
    }

    /*
     * 2. Déduplication exacte par URL.
     */
    const uniqueItems = deduplicateByUrl(allItems);

    /*
     * 3. Regroupement des articles parlant du même sujet.
     */
    const clusters = buildClusters(uniqueItems);

    /*
     * 4. Une seule requête DB pour récupérer les articles récents.
     *
     * L'ancienne version faisait cette requête à chaque cluster.
     */
    const recentArticles = await prisma.article.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
      select: {
        title: true,
        sourceUrl: true,
      },
    });

    const existingSourceUrls = new Set(
      recentArticles
        .map((article) => article.sourceUrl)
        .filter(
          (url): url is string =>
            typeof url === "string" && url.length > 0
        )
        .map((url) => normalizeUrl(url))
    );

    let created = 0;
    let skipped = 0;
    let duplicates = 0;
    let processedClusters = 0;
    let deferred = 0;

    /*
     * On limite le nombre de clusters envoyés à Gemini.
     *
     * Les autres restent pour une prochaine exécution du cron.
     */
    const clustersToProcess = clusters
      .slice()
      .sort((a, b) => {
        const dateA = getLatestDate(a);
        const dateB = getLatestDate(b);

        return dateB - dateA;
      })
      .slice(0, MAX_CLUSTERS_TO_PROCESS);

    deferred += Math.max(
      0,
      clusters.length - clustersToProcess.length
    );

    for (const cluster of clustersToProcess) {
      if (created >= MAX_NEW_ARTICLES) {
        deferred++;
        continue;
      }

      processedClusters++;

      const orderedCluster = [...cluster].sort(
        (a, b) => a.priority - b.priority
      );

      const representative = orderedCluster[0];

      /*
       * Si une des URLs du groupe existe déjà, on ne recrée pas
       * le même article.
       */
      const hasExistingUrl = cluster.some((item) =>
        existingSourceUrls.has(normalizeUrl(item.url))
      );

      if (hasExistingUrl) {
        skipped++;
        continue;
      }

      /*
       * Vérification du titre contre les 100 derniers articles.
       */
      const duplicateTitle = recentArticles.some((article) =>
        areSimilarTitles(article.title, representative.title)
      );

      if (duplicateTitle) {
        duplicates++;
        continue;
      }

      /*
       * Fusion de toutes les sources du même sujet.
       */
      const generated = await generateArticle(cluster);

      if (!generated) {
        deferred++;
        continue;
      }

      if (
        generated.title.length < 20 ||
        generated.content.length < 300
      ) {
        deferred++;
        continue;
      }

      const slug = slugify(generated.title);

      if (!slug) {
        deferred++;
        continue;
      }

      /*
       * Vérification finale du slug.
       */
      const existingSlug = await prisma.article.findUnique({
        where: {
          slug,
        },
        select: {
          id: true,
        },
      });

      if (existingSlug) {
        skipped++;
        continue;
      }

      /*
       * On conserve une URL représentative comme sourceUrl.
       * Les autres sources ont déjà servi à enrichir l'article.
       */
      await prisma.article.create({
        data: {
          title: generated.title,
          slug,
          content: generated.content,
          excerpt: generated.excerpt,
          club: "PSG",
          status: "DRAFT",
          isAiGenerated: true,
          sourceUrl: representative.url,
        },
      });

      created++;

      /*
       * Empêche un doublon dans la même exécution.
       */
      existingSourceUrls.add(
        normalizeUrl(representative.url)
      );
    }

    return NextResponse.json({
      checked: allItems.length,
      newItems: uniqueItems.length,
      clusters: clusters.length,
      processedClusters,
      deferred,
      created,
      skipped,
      duplicates,
      sourcesOk,
      sources,
      fusion: true,
      optimized: true,
    });
  } catch (error) {
    console.error("fetch-articles error:", error);

    return NextResponse.json(
      {
        error: "Erreur lors de la récupération des articles",
        details:
          error instanceof Error
            ? error.message
            : "Erreur inconnue",
      },
      { status: 500 }
    );
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
    xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  for (const itemXml of itemMatches) {
    const title = extractTag(itemXml, "title");

    const description =
      extractTag(itemXml, "description") ||
      extractTag(itemXml, "content:encoded") ||
      "";

    const url =
      extractTag(itemXml, "link") ||
      extractTag(itemXml, "guid") ||
      "";

    const publishedAt =
      extractTag(itemXml, "pubDate") ||
      extractTag(itemXml, "dc:date") ||
      null;

    if (!title || !url) {
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
  const escapedTag = tag.replace(":", "\\:");

  const regex = new RegExp(
    `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
    "i"
  );

  const match = xml.match(regex);

  if (!match) {
    return "";
  }

  return decodeXML(match[1].trim());
}

function decodeXML(value: string): string {
  return value
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/gi,
      "$1"
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(
      /&#(\d+);/g,
      (_, code) =>
        String.fromCharCode(Number(code))
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) =>
        String.fromCharCode(
          parseInt(code, 16)
        )
    );
}

function cleanText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRelevantToPSG(
  title: string,
  description: string
): boolean {
  const text =
    `${title} ${description}`.toLowerCase();

  const keywords = [
    "psg",
    "paris saint-germain",
    "paris saint germain",
    "paris sg",
    "paris-sg",
    "parisien",
    "dembélé",
    "dembele",
    "hakimi",
    "vitinha",
    "marquinhos",
    "kvaratskhelia",
    "doué",
    "doue",
    "barcola",
    "donarumma",
    "mbappé",
    "mbappe",
    "monaco",
    "marseille",
    "om",
    "lyon",
    "lens",
    "lille",
    "ligue 1",
    "ligue1",
    "champions league",
    "ligue des champions",
    "mercato",
    "coupe de france",
    "trophée des champions",
  ];

  return keywords.some((keyword) =>
    text.includes(keyword)
  );
}

function deduplicateByUrl(
  items: FeedItem[]
): FeedItem[] {
  const map = new Map<string, FeedItem>();

  for (const item of items) {
    const normalizedUrl = normalizeUrl(item.url);

    if (!normalizedUrl) {
      continue;
    }

    const existing = map.get(normalizedUrl);

    if (
      !existing ||
      item.priority < existing.priority
    ) {
      map.set(normalizedUrl, item);
    }
  }

  return Array.from(map.values());
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.hash = "";

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

    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    return parsed
      .toString()
      .replace(/\/$/, "");
  } catch {
    return url
      .trim()
      .replace(/\/$/, "");
  }
}

function buildClusters(
  items: FeedItem[]
): FeedItem[][] {
  const clusters: FeedItem[][] = [];

  for (const item of items) {
    let bestCluster: FeedItem[] | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = similarityToCluster(
        item,
        cluster
      );

      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (
      bestCluster &&
      bestScore >= 0.45
    ) {
      bestCluster.push(item);
    } else {
      clusters.push([item]);
    }
  }

  return clusters;
}

function similarityToCluster(
  item: FeedItem,
  cluster: FeedItem[]
): number {
  let best = 0;

  for (const other of cluster) {
    const titleScore = titleSimilarity(
      item.title,
      other.title
    );

    const entityScore = entitySimilarity(
      item.title,
      item.description,
      other.title,
      other.description
    );

    const dateScore = dateSimilarity(
      item,
      other
    );

    const score =
      titleScore * 0.65 +
      entityScore * 0.25 +
      dateScore * 0.1;

    if (score > best) {
      best = score;
    }
  }

  return best;
}

function titleSimilarity(
  a: string,
  b: string
): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));

  if (
    tokensA.size === 0 ||
    tokensB.size === 0
  ) {
    return 0;
  }

  let intersection = 0;

  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection++;
    }
  }

  const union =
    new Set([
      ...tokensA,
      ...tokensB,
    ]).size;

  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function entitySimilarity(
  titleA: string,
  descriptionA: string,
  titleB: string,
  descriptionB: string
): number {
  const entities = [
    "psg",
    "paris saint-germain",
    "monaco",
    "marseille",
    "om",
    "lyon",
    "lens",
    "lille",
    "dembélé",
    "dembele",
    "hakimi",
    "vitinha",
    "marquinhos",
    "kvaratskhelia",
    "doué",
    "doue",
    "barcola",
    "donarumma",
    "mbappé",
    "mbappe",
    "ligue 1",
    "champions league",
    "mercato",
  ];

  const textA =
    `${titleA} ${descriptionA}`.toLowerCase();

  const textB =
    `${titleB} ${descriptionB}`.toLowerCase();

  const entitiesA = entities.filter((entity) =>
    textA.includes(entity)
  );

  const entitiesB = entities.filter((entity) =>
    textB.includes(entity)
  );

  if (
    entitiesA.length === 0 ||
    entitiesB.length === 0
  ) {
    return 0;
  }

  const setB = new Set(entitiesB);

  let intersection = 0;

  for (const entity of entitiesA) {
    if (setB.has(entity)) {
      intersection++;
    }
  }

  const union = new Set([
    ...entitiesA,
    ...entitiesB,
  ]).size;

  return union > 0
    ? intersection / union
    : 0;
}

function dateSimilarity(
  a: FeedItem,
  b: FeedItem
): number {
  if (!a.publishedAt || !b.publishedAt) {
    return 0;
  }

  const dateA = new Date(
    a.publishedAt
  ).getTime();

  const dateB = new Date(
    b.publishedAt
  ).getTime();

  if (
    Number.isNaN(dateA) ||
    Number.isNaN(dateB)
  ) {
    return 0;
  }

  const difference =
    Math.abs(dateA - dateB);

  const hours =
    difference / 3600000;

  if (hours <= 6) {
    return 1;
  }

  if (hours <= 24) {
    return 0.7;
  }

  if (hours <= 48) {
    return 0.4;
  }

  return 0;
}

function getLatestDate(
  cluster: FeedItem[]
): number {
  let latest = 0;

  for (const item of cluster) {
    if (!item.publishedAt) {
      continue;
    }

    const timestamp =
      new Date(
        item.publishedAt
      ).getTime();

    if (
      !Number.isNaN(timestamp) &&
      timestamp > latest
    ) {
      latest = timestamp;
    }
  }

  return latest;
}

function tokenize(
  value: string
): string[] {
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
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 3 &&
        !STOP_WORDS.has(token)
    );
}

const STOP_WORDS = new Set([
  "les",
  "des",
  "une",
  "pour",
  "dans",
  "avec",
  "sur",
  "par",
  "chez",
  "plus",
  "mais",
  "que",
  "qui",
  "est",
  "sont",
  "ses",
  "son",
  "aux",
  "du",
  "de",
  "la",
  "le",
  "un",
  "au",
  "et",
  "en",
  "face",
  "apres",
  "avant",
  "cette",
  "cette",
  "match",
  "club",
  "equipe",
]);

function areSimilarTitles(
  a: string,
  b: string
): boolean {
  const score = titleSimilarity(a, b);

  if (score >= 0.7) {
    return true;
  }

  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);

  if (
    normalizedA === normalizedB &&
    normalizedA.length > 10
  ) {
    return true;
  }

  return false;
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
    .replace(/\s+/g, " ")
    .trim();
}

async function generateArticle(
  cluster: FeedItem[]
): Promise<ArticleResult | null> {
  if (!GEMINI_API_KEY) {
    return null;
  }

  const orderedSources = [...cluster].sort(
    (a, b) =>
      a.priority - b.priority
  );

  /*
   * On donne à Gemini toutes les informations disponibles
   * dans le groupe, mais on limite la taille totale du prompt.
   */
  const sourceBlocks = orderedSources.map(
    (item, index) => {
      const publicationDate =
        item.publishedAt
          ? formatDate(item.publishedAt)
          : "Date inconnue";

      const description =
        item.description.slice(
          0,
          2500
        );

      return [
        `SOURCE ${index + 1}: ${item.source}`,
        `DATE DE PUBLICATION: ${publicationDate}`,
        `TITRE: ${item.title}`,
        `URL: ${item.url}`,
        `INFORMATIONS: ${description || "Aucune information supplémentaire."}`,
      ].join("\n");
    }
  );

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Tu dois transformer plusieurs sources d'actualité en UN SEUL article journalistique original consacré au Paris Saint-Germain.

IMPORTANT :

1. Les sources parlent potentiellement du même événement.
2. Tu dois les fusionner en un seul article.
3. Tu dois utiliser les informations factuelles réellement présentes dans les sources.
4. Ne répète pas les sources sous forme de résumé source par source.
5. Ne cite pas les médias dans le corps de l'article sauf si c'est nécessaire pour attribuer une déclaration.
6. Ne fabrique AUCUNE information.
7. Si une information n'est présente dans aucune source, ne l'invente pas.
8. Si la date est connue, donne-la.
9. Si l'heure du match est connue, donne-la.
10. Si le stade est connu, donne-le.
11. Si la chaîne TV ou la plateforme de diffusion est connue, donne-la.
12. Si la journée de championnat est connue, donne-la.
13. Si l'adversaire est connu, donne-le.
14. Si une compétition est connue, donne-la.
15. Si une composition, blessure, suspension, transfert, déclaration ou information officielle est présente, utilise-la.
16. Lorsque deux sources donnent des informations compatibles, combine-les.
17. Lorsqu'une information apparaît dans une seule source fiable, tu peux l'utiliser mais ne dois pas la présenter comme confirmée par plusieurs médias.
18. En cas de contradiction entre deux sources, ne choisis pas arbitrairement une information : formule prudemment ou ignore l'information contradictoire.
19. L'article doit être factuel et précis.
20. Évite les phrases génériques comme "un match très attendu", "une affiche majeure" ou "les supporters sont impatients" lorsqu'elles n'apportent aucune information.
21. Ne remplis pas l'article avec du texte générique pour atteindre une longueur.
22. Le contenu doit être en français.
23. Le ton doit être celui d'un véritable article de presse sportive.
24. L'article doit être original et ne doit pas copier les formulations des sources.
25. Le PSG doit rester au centre de l'article.

STRUCTURE :

Titre :
Un titre précis et informatif.

Extrait :
Une ou deux phrases résumant les informations principales.

Article :
Environ 400 à 700 mots lorsque les informations disponibles le permettent.

Commence par l'information principale.

Puis ajoute les détails factuels disponibles :
- date
- heure
- compétition
- journée
- stade
- diffusion
- contexte
- joueurs concernés
- absents
- déclarations
- mercato
- résultats récents
- autres informations utiles

N'invente aucun détail manquant.

SOURCES :

${sourceBlocks.join("\n\n---\n\n")}

Retourne UNIQUEMENT un JSON valide avec cette structure :

{
  "title": "Titre de l'article",
  "excerpt": "Résumé court",
  "content": "Article complet"
}
`;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        signal: controller.signal,
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
            responseMimeType: "application/json",
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
      }
    );

    if (!response.ok) {
      const errorText =
        await response.text();

      console.error(
        "Gemini HTTP error:",
        response.status,
        errorText.slice(0, 1000)
      );

      return null;
    }

    const data =
      (await response.json()) as GeminiResponse;

    const text =
      data.candidates?.[0]?.content?.parts?.[0]
        ?.text;

    if (!text) {
      console.error(
        "Gemini n'a retourné aucun contenu"
      );

      return null;
    }

    const parsed =
      parseGeminiJSON(text);

    if (!parsed) {
      console.error(
        "Réponse Gemini JSON invalide:",
        text.slice(0, 1000)
      );

      return null;
    }

    return {
      title: cleanGeneratedText(
        parsed.title
      ),
      excerpt: cleanGeneratedText(
        parsed.excerpt
      ),
      content: cleanGeneratedText(
        parsed.content
      ),
    };
  } catch (error) {
    console.error(
      "Erreur Gemini:",
      error
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseGeminiJSON(
  text: string
): ArticleResult | null {
  try {
    return JSON.parse(text) as ArticleResult;
  } catch {
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(
        cleaned
      ) as ArticleResult;
    } catch {
      return null;
    }
  }
}

function cleanGeneratedText(
  value: string
): string {
  return value
    .replace(
      /^```(?:markdown|text)?/i,
      ""
    )
    .replace(
      /```$/i,
      ""
    )
    .trim();
}

function formatDate(
  value: string
): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(
    "fr-FR",
    {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }
  ).format(date);
}

function slugify(
  value: string
): string {
  return value
    .toString()
    .normalize("NFD")
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
    .slice(0, 180);
}
