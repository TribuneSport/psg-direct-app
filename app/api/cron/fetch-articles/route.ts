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

const MAX_NEW_ARTICLES = 5;
const MAX_ITEMS_PER_SOURCE = 60;

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

    const allItems: FeedItem[] = [];
    const sourcesOk: string[] = [];
    const sources = RSS_FEEDS.map((feed) => feed.name);

    for (const feed of RSS_FEEDS) {
      try {
        const response = await fetch(feed.url, {
          headers: {
            Accept:
              "application/rss+xml, application/xml, text/xml",
            "User-Agent": "PSG-Direct/1.0",
          },
          cache: "no-store",
        });

        if (!response.ok) {
          continue;
        }

        const xml = await response.text();
        const items = parseRSS(xml);

        if (items.length > 0) {
          sourcesOk.push(feed.name);
        }

        for (const item of items.slice(0, MAX_ITEMS_PER_SOURCE)) {
          if (!isRelevantToPSG(item.title, item.description)) {
            continue;
          }

          allItems.push({
            source: feed.name,
            priority: feed.priority,
            title: cleanText(item.title),
            description: cleanText(item.description),
            url: item.url,
            publishedAt: item.publishedAt,
          });
        }
      } catch (error) {
        console.error(
          `Erreur RSS ${feed.name}:`,
          error
        );
      }
    }

    const uniqueItems = deduplicateByUrl(allItems);
    const clusters = buildClusters(uniqueItems);

    let created = 0;
    let skipped = 0;
    let duplicates = 0;
    let processedClusters = 0;
    let deferred = 0;

    for (const cluster of clusters) {
      if (created >= MAX_NEW_ARTICLES) {
        deferred++;
        continue;
      }

      processedClusters++;

      const representative = [...cluster].sort(
        (a, b) => a.priority - b.priority
      )[0];

      const sourceUrls = cluster.map((item) => item.url);

      const existingByUrl = await prisma.article.findFirst({
        where: {
          sourceUrl: {
            in: sourceUrls,
          },
        },
        select: {
          id: true,
        },
      });

      if (existingByUrl) {
        skipped++;
        continue;
      }

      const recentArticles = await prisma.article.findMany({
        orderBy: {
          createdAt: "desc",
        },
        take: 100,
        select: {
          title: true,
        },
      });

      const duplicateTitle = recentArticles.some(
        (article) =>
          areSimilarTitles(
            article.title,
            representative.title
          )
      );

      if (duplicateTitle) {
        duplicates++;
        continue;
      }

      const generated = await generateArticle(cluster);

      if (!generated) {
        deferred++;
        continue;
      }

      if (generated.content.length < 300) {
        deferred++;
        continue;
      }

      const slug = slugify(generated.title);

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
    });
  } catch (error) {
    console.error(
      "fetch-articles error:",
      error
    );

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
    const title = extractTag(
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
  const escapedTag =
    tag.replace(":", "\\:");

  const regex = new RegExp(
    `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
    "i"
  );

  const match = xml.match(regex);

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
          parseInt(code, 16)
        )
    );
}

function cleanText(
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
    "mbappé",
    "mbappe",
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
    "monaco",
    "marseille",
    "om",
    "lyon",
    "lens",
    "lille",
    "ligue 1",
    "champions league",
    "mercato",
  ];

  return keywords.some(
    (keyword) =>
      text.includes(keyword)
  );
}

function deduplicateByUrl(
  items: FeedItem[]
): FeedItem[] {
  const map =
    new Map<string, FeedItem>();

  for (const item of items) {
    const normalizedUrl =
      normalizeUrl(item.url);

    if (!normalizedUrl) {
      continue;
    }

    const existing =
      map.get(normalizedUrl);

    if (
      !existing ||
      item.priority <
        existing.priority
    ) {
      map.set(
        normalizedUrl,
        item
      );
    }
  }

  return Array.from(
    map.values()
  );
}

function normalizeUrl(
  url: string
): string {
  try {
    const parsed =
      new URL(url);

    parsed.hash = "";

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];

    for (const param of trackingParams) {
      parsed.searchParams.delete(
        param
      );
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
    let bestCluster:
      | FeedItem[]
      | null = null;

    let bestScore = 0;

    for (const cluster of clusters) {
      const score =
        similarityToCluster(
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

  for (const other of cluster) {
    const titleScore =
      titleSimilarity(
        item.title,
        other.title
      );

    const entityScore =
      entitySimilarity(
        `${item.title} ${item.description}`,
        `${other.title} ${other.description}`
      );

    const score =
      titleScore * 0.7 +
      entityScore * 0.3;

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
  const wordsA =
    tokenize(a);

  const wordsB =
    tokenize(b);

  if (
    wordsA.length === 0 ||
    wordsB.length === 0
  ) {
    return 0;
  }

  const setA =
    new Set(wordsA);

  const setB =
    new Set(wordsB);

  let common = 0;

  for (const word of setA) {
    if (setB.has(word)) {
      common++;
    }
  }

  const union =
    new Set([
      ...setA,
      ...setB,
    ]).size;

  return union === 0
    ? 0
    : common / union;
}

function entitySimilarity(
  a: string,
  b: string
): number {
  const entities = [
    "psg",
    "paris saint-germain",
    "monaco",
    "marseille",
    "lyon",
    "lens",
    "lille",
    "real madrid",
    "barcelone",
    "barcelona",
    "ligue 1",
    "champions league",
    "mercato",
  ];

  const lowerA =
    a.toLowerCase();

  const lowerB =
    b.toLowerCase();

  let matches = 0;
  let total = 0;

  for (const entity of entities) {
    const inA =
      lowerA.includes(entity);

    const inB =
      lowerB.includes(entity);

    if (inA || inB) {
      total++;

      if (inA && inB) {
        matches++;
      }
    }
  }

  return total === 0
    ? 0
    : matches / total;
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
      (word) =>
        word.length >= 3
    );
}

function areSimilarTitles(
  a: string,
  b: string
): boolean {
  return (
    titleSimilarity(a, b) >=
    0.65
  );
}

async function generateArticle(
  cluster: FeedItem[]
): Promise<ArticleResult | null> {
  const sortedSources =
    [...cluster].sort(
      (a, b) =>
        a.priority -
        b.priority
    );

  const sourceText =
    sortedSources
      .map(
        (item, index) =>
          `SOURCE ${index + 1}
Nom: ${item.source}
Priorité: ${item.priority}
Titre: ${item.title}
Description: ${item.description}
URL: ${item.url}
Date de publication: ${item.publishedAt ?? "Non précisée"}`
      )
      .join("\n\n");

  const prompt = `
Tu es le rédacteur en chef de PSG Direct.

Tu dois créer UN SEUL article de presse sportive original à partir de plusieurs sources qui parlent du même sujet.

OBJECTIF PRINCIPAL :
Produire un article précis, concret et informatif, jamais un texte générique.

IMPORTANT :
- Les différentes sources peuvent parler exactement du même événement.
- Fusionne toutes les informations utiles des sources.
- Ne crée qu'un seul article pour le sujet.
- Ne jamais inventer une information.
- Ne jamais compléter une information absente par une supposition.
- Si une information apparaît dans une source, utilise-la.
- Si plusieurs sources confirment une information, donne-lui la priorité.
- Si les sources se contredisent, ne choisis pas arbitrairement.
- Si une information n'est disponible dans aucune source, ne l'invente pas.

CHERCHE PARTICULIÈREMENT :
- date du match ou de l'événement
- heure
- stade
- ville
- compétition
- journée de championnat
- adversaire
- chaîne TV
- plateforme de diffusion
- joueurs concernés
- absents
- blessés
- suspendus
- compositions probables
- classement
- résultats précédents
- contexte
- mercato
- montant d'un transfert
- durée d'un contrat
- déclarations
- entraîneur
- enjeux sportifs

RÈGLE ABSOLUE :
Si une information précise est disponible dans les sources, elle doit apparaître dans l'article lorsque cela est pertinent.

Exemple :
Si les sources indiquent que PSG-Monaco se joue vendredi à 21h05 au Parc des Princes et est diffusé sur une chaîne précise, ces informations doivent apparaître dans l'article.

Ne remplace jamais des informations précises par des formulations vagues comme :
"une rencontre très attendue"
"un choc important"
"les supporters pourront suivre la rencontre"
lorsque les détails précis sont disponibles.

STYLE :
- français naturel
- journalisme sportif
- phrases variées
- paragraphes courts
- informations factuelles
- aucun remplissage
- aucun commentaire inventé
- article original
- centré sur le PSG

Le titre doit être informatif et précis.

Le résumé doit résumer réellement l'information principale.

Le contenu doit être suffisamment développé pour expliquer le sujet au lecteur.

Retourne STRICTEMENT ce JSON :

{
  "title": "titre",
  "excerpt": "résumé de 1 à 2 phrases",
  "content": "article complet en plusieurs paragraphes"
}

SOURCES :

${sourceText}
`;

  try {
    const response =
      await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
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
        }
      );

    if (!response.ok) {
      console.error(
        "Gemini HTTP error:",
        response.status,
        await response.text()
      );

      return null;
    }

    const data =
      (await response.json()) as GeminiResponse;

    const text =
      data
        .candidates?.[0]
        ?.content?.parts?.[0]
        ?.text;

    if (!text) {
      return null;
    }

    const parsed =
      JSON.parse(text) as ArticleResult;

    if (
      !parsed.title ||
      !parsed.excerpt ||
      !parsed.content
    ) {
      return null;
    }

    return {
      title: cleanText(
        parsed.title
      ),
      excerpt: cleanText(
        parsed.excerpt
      ),
      content:
        parsed.content.trim(),
    };
  } catch (error) {
    console.error(
      "Gemini generation error:",
      error
    );

    return null;
  }
}

function slugify(
  title: string
): string {
  const base =
    title
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
        /(^-|-$)/g,
        ""
      );

  return `${base}-${Date.now().toString(36)}`;
}
