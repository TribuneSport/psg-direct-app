import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

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

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");

  if (secret !== CRON_SECRET) {
    return NextResponse.json(
      { error: "non autorisé" },
      { status: 401 }
    );
  }

  const { items, sourcesOk } = await fetchAllRssItems();

  let created = 0;
  let skipped = 0;
  let duplicates = 0;

  const selected: RssItem[] = [];

  for (const item of items) {
    const existing = await prisma.article.findUnique({
      where: {
        sourceUrl: item.link,
      },
    });

    if (existing) {
      skipped++;
      continue;
    }

    if (
      selected.some((other) =>
        areSameSubject(other.title, item.title)
      )
    ) {
      duplicates++;
      continue;
    }

    selected.push(item);
  }

  // Maximum 5 nouveaux articles par passage.
  for (const item of selected.slice(0, 5)) {
    const rewritten = await rewriteWithGemini(
      item.title,
      item.description
    );

    if (!rewritten) {
      continue;
    }

    const slug = slugify(rewritten.title);

    await prisma.article.create({
      data: {
        title: rewritten.title,
        slug,
        content: rewritten.content,
        excerpt: rewritten.excerpt,
        club: "PSG",
        status: "DRAFT",
        isAiGenerated: true,
        sourceUrl: item.link,
      },
    });

    created++;
  }

  return NextResponse.json({
    checked: items.length,
    created,
    skipped,
    duplicates,
    sourcesOk,
    sources: RSS_FEEDS.map((feed) => feed.name),
  });
}

type RssItem = {
  title: string;
  description: string;
  link: string;
  source: string;
};

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
        feed.name
      );

      if (items.length > 0) {
        sourcesOk.push(feed.name);
        allItems.push(...items);
      }
    } catch {
      // Une source indisponible ne bloque pas les autres.
    }
  }

  return {
    items: allItems,
    sourcesOk,
  };
}

async function fetchRssItems(
  url: string,
  source: string
): Promise<RssItem[]> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "PSG-Direct/1.0 RSS reader",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    return [];
  }

  const xml = await res.text();

  const items: RssItem[] = [];

  const itemBlocks = xml
    .split("<item>")
    .slice(1);

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(
      block,
      "description"
    );

    if (title && link) {
      items.push({
        title: cleanText(title),
        link: cleanText(link),
        description: cleanText(description),
        source,
      });
    }
  }

  return items;
}

function extractTag(
  xml: string,
  tag: string
): string {
  const match = xml.match(
    new RegExp(
      `<${tag}>([\\s\\S]*?)<\\/${tag}>`
    )
  );

  return match ? match[1] : "";
}

function cleanText(text: string): string {
  return text
    .replace("<![CDATA[", "")
    .replace("]]>", "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(le|la|les|un|une|des|du|de|pour|avec|sur|dans|et|a|au|aux)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function areSameSubject(
  a: string,
  b: string
): boolean {
  const wordsA = new Set(
    normalizeTitle(a)
      .split(" ")
      .filter(Boolean)
  );

  const wordsB = new Set(
    normalizeTitle(b)
      .split(" ")
      .filter(Boolean)
  );

  if (!wordsA.size || !wordsB.size) {
    return false;
  }

  let common = 0;

  for (const word of wordsA) {
    if (wordsB.has(word)) {
      common++;
    }
  }

  const similarity =
    common / Math.min(wordsA.size, wordsB.size);

  return similarity >= 0.75;
}

async function rewriteWithGemini(
  originalTitle: string,
  originalDescription: string
): Promise<{
  title: string;
  excerpt: string;
  content: string;
} | null> {
  const prompt = `Tu es journaliste sportif spécialisé dans le PSG.

Voici une information brute provenant d'une source sportive.

Source :
${originalTitle}

Résumé / informations disponibles :
${originalDescription}

Rédige un article ORIGINAL en français à partir des informations réellement fournies.

Consignes :
- Ne recopie jamais les phrases originales.
- Reformule entièrement.
- N'invente absolument aucune information.
- Si une date est présente, conserve-la précisément.
- Si une heure est présente, conserve-la précisément.
- Si une chaîne de diffusion est présente, conserve-la précisément.
- Si un stade est présent, conserve-le précisément.
- Si un joueur est présent, conserve son nom précisément.
- Si une compétition est présente, conserve-la précisément.
- Si un résultat est présent, conserve-le précisément.
- Si une information importante n'est pas présente, ne la devine pas.
- Ne fabrique jamais une chaîne TV.
- Ne fabrique jamais une date ou une heure.
- N'écris pas qu'une information est disponible si elle ne l'est pas.
- Un titre accrocheur mais factuel.
- Un résumé court d'une phrase.
- Un contenu de 2 à 4 paragraphes.
- Reste factuel et précis.

Réponds STRICTEMENT au format JSON suivant, sans aucun texte autour :

{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
        }),
      }
    );

    if (!res.ok) {
      return null;
    }

    const data = await res.json();

    const text =
      data.candidates?.[0]?.content?.parts?.[0]
        ?.text ?? "";

    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed.title || !parsed.content) {
      return null;
    }

    return {
      title: parsed.title,
      excerpt: parsed.excerpt || "",
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") +
    "-" +
    Date.now().toString(36)
  );
}
