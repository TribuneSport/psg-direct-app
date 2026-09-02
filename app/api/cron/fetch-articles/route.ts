import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const CRON_SECRET = process.env.CRON_SECRET!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

// Flux Google News filtré sur le PSG : agrège de nombreuses sources
// françaises automatiquement, sans dépendre d'un seul site en particulier.
const RSS_URL = "https://news.google.com/rss/search?q=PSG+Paris+Saint-Germain+football&hl=fr&gl=FR&ceid=FR:fr";

// GET /api/cron/fetch-articles?secret=xxx
//
// Appelée périodiquement (ex: toutes les 30-60 min) par cron-job.org.
// Pour chaque actu PSG pas encore connue : réécrit le contenu avec Gemini
// (pour éviter de publier le texte original protégé), puis crée un
// brouillon. Ne publie JAMAIS automatiquement — validation manuelle requise.
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== CRON_SECRET) {
    return NextResponse.json({ error: "non autorisé" }, { status: 401 });
  }

  const items = await fetchRssItems();
  let created = 0;
  let skipped = 0;

  // On limite à 5 nouveaux articles par appel, pour ne jamais dépasser le
  // quota gratuit de Gemini même si beaucoup d'actus tombent d'un coup.
  for (const item of items.slice(0, 5)) {
    const existing = await prisma.article.findUnique({ where: { sourceUrl: item.link } });
    if (existing) {
      skipped++;
      continue;
    }

    const rewritten = await rewriteWithGemini(item.title, item.description);
    if (!rewritten) continue; // échec de réécriture : on saute, on réessaiera au prochain passage

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

  return NextResponse.json({ checked: items.length, created, skipped });
}

type RssItem = { title: string; description: string; link: string };

async function fetchRssItems(): Promise<RssItem[]> {
  const res = await fetch(RSS_URL);
  if (!res.ok) return [];
  const xml = await res.text();

  // Extraction simple des balises <item> par expression régulière : évite
  // d'ajouter une dépendance externe pour un flux RSS au format standard.
  const items: RssItem[] = [];
  const itemBlocks = xml.split("<item>").slice(1);

  for (const block of itemBlocks) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");
    if (title && link) {
      items.push({ title: cleanText(title), link: cleanText(link), description: cleanText(description) });
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : "";
}

function cleanText(text: string): string {
  return text
    .replace("<![CDATA[", "")
    .replace("]]>", "")
    .replace(/<[^>]+>/g, "") // retire les balises HTML éventuelles
    .trim();
}

async function rewriteWithGemini(
  originalTitle: string,
  originalDescription: string
): Promise<{ title: string; excerpt: string; content: string } | null> {
  const prompt = `Tu es journaliste sportif spécialisé PSG. Voici une information brute :
Titre : ${originalTitle}
Résumé : ${originalDescription}

Rédige un article ORIGINAL en français à partir de cette information (ne recopie jamais les phrases telles quelles, reformule entièrement) :
- Un titre accrocheur (une phrase)
- Un résumé court (1 phrase, pour un aperçu)
- Un contenu de 2-3 paragraphes

Réponds STRICTEMENT au format JSON suivant, sans aucun texte autour :
{"title": "...", "excerpt": "...", "content": "..."}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.title || !parsed.content) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36)
  );
}
