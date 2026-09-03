import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const RSS_URL =
  "https://news.google.com/rss/search?q=PSG+Paris+Saint-Germain+football&hl=fr&gl=FR&ceid=FR:fr";

export async function GET(req: NextRequest) {
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

  try {
    const items = await fetchRssItems();

    let created = 0;
    let skipped = 0;
    let failed = 0;

    const errors: string[] = [];

    for (const item of items.slice(0, 5)) {
      try {
        const existing = await prisma.article.findUnique({
          where: {
            sourceUrl: item.link,
          },
        });

        if (existing) {
          skipped++;
          continue;
        }

        const rewritten = await rewriteWithGemini(
          item.title,
          item.description
        );

        if (!rewritten) {
          failed++;
          errors.push(
            `Gemini n'a pas pu réécrire : ${item.title.substring(0, 100)}`
          );
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
      } catch (error) {
        failed++;

        const message =
          error instanceof Error ? error.message : String(error);

        errors.push(
          `Article "${item.title.substring(0, 80)}" : ${message}`
        );

        console.error("Erreur traitement article :", error);
      }
    }

    return NextResponse.json({
      checked: items.length,
      processed: Math.min(items.length, 5),
      created,
      skipped,
      failed,
      errors,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error("Erreur globale fetch-articles :", error);

    return NextResponse.json(
      {
        error: "Erreur lors de l'exécution du cron",
        details: message,
      },
      { status: 500 }
    );
  }
}

type RssItem = {
  title: string;
  description: string;
  link: string;
};

async function fetchRssItems(): Promise<RssItem[]> {
  const res = await fetch(RSS_URL, {
    headers: {
      "User-Agent": "PSG-Direct/1.0",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `Google News RSS a répondu avec le statut HTTP ${res.status}`
    );
  }

  const xml = await res.text();

  const items: RssItem[] = [];
  const itemBlocks = xml.split("<item>").slice(1);

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");

    if (title && link) {
      items.push({
        title: cleanText(title),
        link: cleanText(link),
        description: cleanText(description),
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)
  );

  return match ? match[1] : "";
}

function cleanText(text: string): string {
  return text
    .replace("<![CDATA[", "")
    .replace("]]>", "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

async function rewriteWithGemini(
  originalTitle: string,
  originalDescription: string
): Promise<{
  title: string;
  excerpt: string;
  content: string;
} | null> {
  const prompt = `Tu es journaliste sportif spécialisé dans le Paris Saint-Germain.

À partir de l'information brute ci-dessous, rédige un article sportif ORIGINAL en français.

Titre source :
${originalTitle}

Description source :
${originalDescription}

Consignes :
- Reformule entièrement l'information.
- Ne recopie pas les phrases de la source.
- Ne crée aucune information qui n'est pas présente dans la source.
- Crée un titre clair et accrocheur.
- Crée un résumé d'une seule phrase.
- Crée un contenu de 2 à 3 paragraphes.
- Le contenu doit être naturel et journalistique.

Réponds STRICTEMENT avec un objet JSON valide, sans markdown et sans texte avant ou après.

Format attendu :
{
  "title": "...",
  "excerpt": "...",
  "content": "..."
}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
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
          generationConfig: {
            temperature: 0.7,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const responseText = await res.text();

    if (!res.ok) {
      console.error(
        `Gemini HTTP ${res.status}:`,
        responseText.substring(0, 2000)
      );

      throw new Error(
        `Gemini HTTP ${res.status} : ${extractGeminiError(responseText)}`
      );
    }

    let data: any;

    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Réponse Gemini impossible à analyser : ${responseText.substring(
          0,
          1000
        )}`
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!text) {
      const finishReason =
        data?.candidates?.[0]?.finishReason ?? "inconnu";

      throw new Error(
        `Gemini n'a retourné aucun texte. finishReason=${finishReason}`
      );
    }

    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsed: {
      title?: string;
      excerpt?: string;
      content?: string;
    };

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        `JSON Gemini invalide : ${cleaned.substring(0, 1500)}`
      );
    }

    if (!parsed.title || !parsed.content) {
      throw new Error(
        `Réponse Gemini incomplète : ${JSON.stringify(parsed).substring(
          0,
          1500
        )}`
      );
    }

    return {
      title: String(parsed.title).trim(),
      excerpt: String(parsed.excerpt ?? "").trim(),
      content: String(parsed.content).trim(),
    };
  } catch (error) {
    console.error("Erreur Gemini :", error);

    throw error;
  }
}

function extractGeminiError(responseText: string): string {
  try {
    const data = JSON.parse(responseText);

    return (
      data?.error?.message ??
      data?.error?.status ??
      responseText.substring(0, 1000)
    );
  } catch {
    return responseText.substring(0, 1000);
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
