````ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

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

type RssItem = {
  title: string;
  description: string;
  link: string;
  source: string;
  priority: number;
  pubDate?: string;
};

type ArticleSource = {
  source: string;
  title: string;
  description: string;
  link: string;
  priority: number;
};

type ArticleCluster = {
  items: RssItem[];
  representative: RssItem;
};

type GeminiArticle = {
  title: string;
  excerpt: string;
  content: string;
};

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");

  if (secret !== CRON_SECRET) {
    return NextResponse.json(
      { error: "non autorisé" },
      { status: 401 }
    );
  }

  if (!GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY manquante" },
      { status: 500 }
    );
  }

  const { items, sourcesOk } = await fetchAllRssItems();

  if (items.length === 0) {
    return NextResponse.json({
      checked: 0,
      clusters: 0,
      created: 0,
      skipped: 0,
      duplicates: 0,
      sourcesOk,
      sources: RSS_FEEDS.map((feed) => feed.name),
    });
  }

  /*
   * 1. On élimine les URL déjà présentes en base.
   */
  const existingUrls = new Set<string>();

  for (const item of items) {
    const existing = await prisma.article.findUnique({
      where: {
        sourceUrl: item.link,
      },
      select: {
        id: true,
      },
    });

    if (existing) {
      existingUrls.add(item.link);
    }
  }

  const newItems = items.filter(
    (item) => !existingUrls.has(item.link)
  );

  /*
   * 2. On regroupe les articles parlant du même sujet.
   *
   * Exemple :
   * RMC : "PSG-Monaco : l'heure du match"
   * CulturePSG : "PSG - Monaco, le programme complet"
   *
   * => UN SEUL cluster.
   */
  const clusters = buildClusters(newItems);

  let created = 0;
  let skipped = existingUrls.size;
  let duplicates = 0;

  /*
   * 3. On traite les clusters les plus riches en premier.
   *
   * Un cluster avec 3 sources est prioritaire
   * sur un cluster avec une seule source.
   */
  clusters.sort((a, b) => {
    if (b.items.length !== a.items.length) {
      return b.items.length - a.items.length;
    }

    return (
      new Date(
        b.representative.pubDate ?? 0
      ).getTime() -
      new Date(
        a.representative.pubDate ?? 0
      ).getTime()
    );
  });

  const processedClusters = clusters.slice(
    0,
    MAX_NEW_ARTICLES
  );

  /*
   * 4. UN ARTICLE GEMINI PAR SUJET.
   */
  for (const cluster of processedClusters) {
    const sources = cluster.items
      .sort((a, b) => a.priority - b.priority)
      .map((item) => ({
        source: item.source,
        title: item.title,
        description: item.description,
        link: item.link,
        priority: item.priority,
      }));

    /*
     * Vérification supplémentaire contre les articles
     * récemment créés en base.
     */
    const recentArticles = await prisma.article.findMany({
      where: {
        club: "PSG",
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 100,
      select: {
        title: true,
      },
    });

    const alreadyCovered = recentArticles.some((article) =>
      areSameSubject(
        article.title,
        cluster.representative.title
      )
    );

    if (alreadyCovered) {
      duplicates++;
      continue;
    }

    const rewritten = await rewriteClusterWithGemini(
      sources
    );

    if (!rewritten) {
      skipped++;
      continue;
    }

    /*
     * Évite les doublons générés par Gemini.
     */
    const duplicateGenerated = recentArticles.some(
      (article) =>
        areSameSubject(
          article.title,
          rewritten.title
        )
    );

    if (duplicateGenerated) {
      duplicates++;
      continue;
    }

    const slug = slugify(rewritten.title);

    try {
      await prisma.article.create({
        data: {
          title: rewritten.title,
          slug,
          content: rewritten.content,
          excerpt: rewritten.excerpt,
          club: "PSG",
          status: "DRAFT",
          isAiGenerated: true,
          sourceUrl:
            cluster.representative.link,
        },
      });

      created++;
    } catch {
      skipped++;
    }
  }

  /*
   * Les clusters non traités parce que la limite de 5 est atteinte
   * sont considérés comme reportés, pas comme des doublons.
   */
  const deferred =
    Math.max(0, clusters.length - processedClusters.length);

  return NextResponse.json({
    checked: items.length,
    newItems: newItems.length,
    clusters: clusters.length,
    processedClusters: processedClusters.length,
    deferred,
    created,
    skipped,
    duplicates,
    sourcesOk,
    sources: RSS_FEEDS.map((feed) => feed.name),
    fusion: true,
  });
}

/* ============================================================
   RSS
   ============================================================ */

async function fetchAllRssItems(): Promise<{
  items: RssItem[];
  sourcesOk: string[];
}> {
  const allItems: RssItem[] = [];
  const sourcesOk: string[] = [];

  for (const feed of RSS_FEEDS) {
    try {
      const items = await fetchRssItems(
        feed.url,
        feed.name,
        feed.priority
      );

      if (items.length > 0) {
        sourcesOk.push(feed.name);

        allItems.push(
          ...items.slice(0, MAX_ITEMS_PER_SOURCE)
        );
      }
    } catch {
      // Une source HS ne bloque pas les autres.
    }
  }

  return {
    items: allItems,
    sourcesOk,
  };
}

async function fetchRssItems(
  url: string,
  source: string,
  priority: number
): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "PSG-Direct/1.0 RSS reader",
      Accept:
        "application/rss+xml, application/xml, text/xml",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    return [];
  }

  const xml = await res.text();

  const items: RssItem[] = [];

  const itemBlocks = xml
    .split(/<item[\s>]/i)
    .slice(1);

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link =
      extractTag(block, "link") ||
      extractAtomLink(block);

    const description =
      extractTag(block, "description") ||
      extractTag(block, "content:encoded");

    const pubDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated");

    if (!title || !link) {
      continue;
    }

    const cleanedTitle = cleanText(title);
    const cleanedDescription =
      cleanText(description);

    if (!isRelevantPsgArticle(
      cleanedTitle,
      cleanedDescription
    )) {
      continue;
    }

    items.push({
      title: cleanedTitle,
      description: cleanedDescription,
      link: cleanUrl(link),
      source,
      priority,
      pubDate: cleanText(pubDate),
    });
  }

  return items;
}

function extractTag(
  xml: string,
  tag: string
): string {
  const escapedTag = tag.replace(
    /[-/\\^$*+?.()|[\]{}]/g,
    "\\$&"
  );

  const match = xml.match(
    new RegExp(
      `<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`,
      "i"
    )
  );

  return match ? match[1] : "";
}

function extractAtomLink(xml: string): string {
  const match = xml.match(
    /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i
  );

  return match ? match[1] : "";
}

function cleanUrl(url: string): string {
  return url
    .replace("<![CDATA[", "")
    .replace("]]>", "")
    .trim();
}

function cleanText(text: string): string {
  return text
    .replace(/<!\[CDATA\[/gi, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(
          Number(code)
        );
      } catch {
        return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

/* ============================================================
   FILTRE PSG
   ============================================================ */

function isRelevantPsgArticle(
  title: string,
  description: string
): boolean {
  const text = normalizeText(
    `${title} ${description}`
  );

  const keywords = [
    "psg",
    "paris saint-germain",
    "paris saint germain",
    "mbappe",
    "dembele",
    "hakimi",
    "vitinha",
    "barcola",
    "marquinhos",
    "donarumma",
    "kvaratskhelia",
    "monaco",
    "marseille",
    "om",
    "lyon",
    "lens",
    "lille",
    "ligue 1",
    "ligue1",
    "champions league",
    "mercato",
  ];

  return keywords.some((keyword) =>
    text.includes(normalizeText(keyword))
  );
}

/* ============================================================
   CLUSTERING / FUSION
   ============================================================ */

function buildClusters(
  items: RssItem[]
): ArticleCluster[] {
  const clusters: ArticleCluster[] = [];

  for (const item of items) {
    let bestCluster: ArticleCluster | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const representative =
        cluster.representative;

      const score = subjectScore(
        representative,
        item
      );

      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    /*
     * Seuil volontairement assez strict.
     *
     * On veut fusionner :
     * "PSG - Monaco : l'heure du match"
     * "PSG-Monaco : le programme complet"
     *
     * mais PAS :
     * "PSG : Dembélé forfait"
     * avec
     * "PSG : Dembélé prolonge".
     */
    if (bestCluster && bestScore >= 0.58) {
      bestCluster.items.push(item);

      /*
       * La meilleure source devient la représentante.
       */
      if (
        item.priority <
        bestCluster.representative.priority
      ) {
        bestCluster.representative = item;
      }
    } else {
      clusters.push({
        items: [item],
        representative: item,
      });
    }
  }

  return clusters;
}

function subjectScore(
  a: RssItem,
  b: RssItem
): number {
  const titleA = tokenize(a.title);
  const titleB = tokenize(b.title);

  if (!titleA.length || !titleB.length) {
    return 0;
  }

  const common = intersectionSize(
    titleA,
    titleB
  );

  const titleSimilarity =
    common /
    Math.max(
      1,
      Math.min(
        titleA.size,
        titleB.size
      )
    );

  /*
   * On compare aussi les entités importantes.
   */
  const entitiesA =
    extractEntities(
      `${a.title} ${a.description}`
    );

  const entitiesB =
    extractEntities(
      `${b.title} ${b.description}`
    );

  const commonEntities =
    intersectionSize(
      entitiesA,
      entitiesB
    );

  let entityBonus = 0;

  if (commonEntities >= 2) {
    entityBonus = 0.20;
  } else if (commonEntities === 1) {
    entityBonus = 0.08;
  }

  /*
   * Même date = gros indice de même événement.
   */
  const dateA =
    extractDate(`${a.title} ${a.description}`);

  const dateB =
    extractDate(`${b.title} ${b.description}`);

  let dateBonus = 0;

  if (
    dateA &&
    dateB &&
    dateA === dateB
  ) {
    dateBonus = 0.15;
  }

  /*
   * Même heure = indice supplémentaire.
   */
  const timeA =
    extractTime(`${a.title} ${a.description}`);

  const timeB =
    extractTime(`${b.title} ${b.description}`);

  let timeBonus = 0;

  if (
    timeA &&
    timeB &&
    timeA === timeB
  ) {
    timeBonus = 0.10;
  }

  return Math.min(
    1,
    titleSimilarity +
      entityBonus +
      dateBonus +
      timeBonus
  );
}

function normalizeTitle(
  title: string
): string {
  return normalizeText(title)
    .replace(
      /\b(le|la|les|un|une|des|du|de|pour|avec|sur|dans|et|a|au|aux|ce|cette|ces|son|sa|ses)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(
  text: string
): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(
  text: string
): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(" ")
      .filter(
        (word) =>
          word.length >= 3
      )
  );
}

function intersectionSize(
  a: Set<string>,
  b: Set<string>
): number {
  let count = 0;

  for (const value of a) {
    if (b.has(value)) {
      count++;
    }
  }

  return count;
}

function extractEntities(
  text: string
): Set<string> {
  const normalized =
    normalizeText(text);

  const entities = [
    "psg",
    "monaco",
    "marseille",
    "om",
    "lyon",
    "lens",
    "lille",
    "real madrid",
    "barcelone",
    "chelsea",
    "arsenal",
    "liverpool",
    "manchester city",
    "bayern",
    "juventus",
    "dembele",
    "mbappe",
    "hakimi",
    "vitinha",
    "barcola",
    "marquinhos",
    "donarumma",
    "kvaratskhelia",
    "desire doue",
    "ligue 1",
    "champions league",
    "mercato",
  ];

  const result = new Set<string>();

  for (const entity of entities) {
    if (
      normalized.includes(
        normalizeText(entity)
      )
    ) {
      result.add(
        normalizeText(entity)
      );
    }
  }

  return result;
}

function extractDate(
  text: string
): string | null {
  const match = text.match(
    /\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/
  );

  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3] ?? ""}`;
}

function extractTime(
  text: string
): string | null {
  const match = text.match(
    /\b([01]?\d|2[0-3])(?:h|:)([0-5]\d)?\b/i
  );

  if (!match) {
    return null;
  }

  return `${match[1]}:${match[2] ?? "00"}`;
}

function areSameSubject(
  a: string,
  b: string
): boolean {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  if (!wordsA.size || !wordsB.size) {
    return false;
  }

  const common =
    intersectionSize(
      wordsA,
      wordsB
    );

  const similarity =
    common /
    Math.min(
      wordsA.size,
      wordsB.size
    );

  return similarity >= 0.75;
}

/* ============================================================
   GEMINI
   ============================================================ */

async function rewriteClusterWithGemini(
  sources: ArticleSource[]
): Promise<GeminiArticle | null> {
  const evidence = sources
    .map(
      (source, index) => `
SOURCE ${index + 1}
Nom : ${source.source}
Priorité : ${source.priority}
Titre : ${source.title}
Informations disponibles : ${source.description}
Lien : ${source.link}
`
    )
    .join("\n");

  const prompt = `
Tu es le journaliste en chef de PSG Direct.

Tu dois créer UN SEUL article original à partir de plusieurs sources
qui parlent du même sujet.

IMPORTANT :
Les sources peuvent être incomplètes.
Elles peuvent également se répéter.
Tu dois FUSIONNER les informations utiles et ne jamais créer plusieurs
articles pour le même événement.

========================
SOURCES DISPONIBLES
========================

${evidence}

========================
OBJECTIF
========================

Produis un article sportif français précis et informatif.

Tu dois chercher dans les sources les informations concrètes suivantes :

- adversaire
- compétition
- date
- jour
- heure
- stade
- ville
- chaîne TV
- plateforme de diffusion
- journée de championnat
- joueurs concernés
- entraîneur
- blessure
- suspension
- transfert
- montant
- durée du contrat
- résultat
- score
- buteurs
- contexte sportif
- classement
- prochaine échéance
- toute autre information factuelle réellement présente

========================
RÈGLES ABSOLUES
========================

1. N'INVENTE AUCUNE INFORMATION.

2. Si une information n'est présente dans aucune source,
   tu dois l'omettre.

3. Ne devine jamais une heure.

4. Ne devine jamais une chaîne TV.

5. Ne devine jamais un stade.

6. Ne devine jamais une date.

7. Ne devine jamais un résultat.

8. Si deux sources donnent des informations différentes :
   - privilégie la source la plus fiable ;
   - si le conflit ne peut pas être résolu,
     n'utilise pas l'information contestée.

9. Les informations officielles doivent être privilégiées
   lorsqu'elles sont présentes.

10. Les sources secondaires servent à enrichir l'article.

11. Ne recopie pas les phrases des sources.

12. Reformule entièrement.

13. Ne mentionne jamais "selon plusieurs sources"
   si ce n'est pas nécessaire.

14. Ne crée pas une information simplement parce qu'elle
   est habituelle dans le football.

15. L'article doit être concret.

16. Évite les phrases génériques comme :
   "une rencontre très attendue",
   "un choc au sommet",
   "les supporters sont impatients",
   si elles n'apportent aucune information.

17. Si les sources donnent une date et une heure,
   elles doivent apparaître dans l'article.

18. Si les sources donnent une chaîne TV,
   elle doit apparaître dans l'article.

19. Si les sources donnent un stade,
   il doit apparaître dans l'article.

20. Le résumé doit contenir une information concrète.

========================
STYLE PSG DIRECT
========================

Titre :
- clair
- naturel
- informatif
- pas de titre sensationnaliste

Résumé :
- une phrase
- information concrète
- maximum environ 180 caractères

Article :
- 4 à 7 paragraphes
- style presse sportive
- phrases courtes et naturelles
- priorité aux faits
- pas de remplissage

========================
FORMAT
========================

Retourne STRICTEMENT un JSON valide :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}
`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
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

    if (!res.ok) {
      console.error(
        "Gemini HTTP error:",
        res.status,
        await res.text()
      );

      return null;
    }

    const data = await res.json();

    const text =
      data.candidates?.[0]
        ?.content?.parts?.[0]
        ?.text ?? "";

    if (!text) {
      return null;
    }

    const cleaned = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const parsed =
      JSON.parse(cleaned);

    if (
      !parsed.title ||
      !parsed.content
    ) {
      return null;
    }

    return {
      title:
        String(parsed.title).trim(),
      excerpt:
        String(
          parsed.excerpt ?? ""
        ).trim(),
      content:
        String(
          parsed.content
        ).trim(),
    };
  } catch (error) {
    console.error(
      "Gemini error:",
      error
    );

    return null;
  }
}

/* ============================================================
   SLUG
   ============================================================ */

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

  return (
    `${base}-${Date.now().toString(36)}`
  );
}
````
