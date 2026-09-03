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

    if (items.length === 0) {
      return NextResponse.json({
        checked: 0,
        processed: 0,
        created: 0,
        skipped: 0,
        failed: 0,
        errors: [],
      });
    }

    /*
     * Un seul article est traité par exécution.
     *
     * Cela permet de rester sous la limite de 30 secondes
     * de cron-job.org.
     */

    let selectedItem: RssItem | null = null;

    for (const item of items) {
      const existing = await prisma.article.findUnique({
        where: {
          sourceUrl: item.link,
        },
        select: {
          id: true,
        },
      });

      if (!existing) {
        selectedItem = item;
        break;
      }
    }

    if (!selectedItem) {
      return NextResponse.json({
        checked: items.length,
        processed: 0,
        created: 0,
        skipped: items.length,
        failed: 0,
        errors: [],
        message: "Tous les articles RSS disponibles existent déjà.",
      });
    }

    try {
      const rewritten = await rewriteWithGemini(
        selectedItem.title,
        selectedItem.description
      );

      const slug = slugify(rewritten.title);

      const article = await prisma.article.create({
        data: {
          title: rewritten.title,
          slug,
          content: rewritten.content,
          excerpt: rewritten.excerpt,
          club: "PSG",
          status: "DRAFT",
          isAiGenerated: true,
          sourceUrl: selectedItem.link,
        },
      });

      return NextResponse.json({
        checked: items.length,
        processed: 1,
        created: 1,
        skipped: items.length - 1,
        failed: 0,
        errors: [],
        article: {
          id: article.id,
          title: article.title,
          status: article.status,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      console.error("Erreur traitement article :", error);

      return NextResponse.json({
        checked: items.length,
        processed: 1,
        created: 0,
        skipped: 0,
        failed: 1,
        errors: [
          `Article "${selectedItem.title.substring(
            0,
            100
          )}" : ${message}`,
        ],
      });
    }
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
}> {
  const prompt = `Tu es un journaliste sportif professionnel spécialisé dans le Paris Saint-Germain.

Ta mission est de transformer l'information source ci-dessous en un véritable article de presse sportive ORIGINAL, précis, factuel et naturel en français.

================ INFORMATION SOURCE ================

Titre source :
${originalTitle}

Description source :
${originalDescription}

=====================================================


RÈGLE ABSOLUE : CONSERVE LES FAITS IMPORTANTS

Tu dois d'abord identifier mentalement tous les faits présents dans le titre et la description source avant de rédiger.

Tu dois conserver dans l'article, lorsqu'ils sont présents dans la source :

- les noms des équipes ;
- les noms des joueurs ;
- les noms des entraîneurs ;
- les noms des dirigeants ;
- la compétition ;
- la date ;
- l'heure exacte du match ou de l'événement ;
- la chaîne TV ;
- la plateforme de diffusion ;
- le diffuseur ;
- le stade ou le lieu ;
- le score ;
- les absences ;
- les blessures ;
- les suspensions ;
- les informations de mercato ;
- les montants ;
- les durées de contrat ;
- les dates de contrat ;
- toutes les autres données chiffrées importantes ;
- toutes les informations concrètes permettant de comprendre l'actualité.


=====================================================
RÈGLE SPÉCIALE POUR LES ARTICLES MATCH / TV / DIFFUSION
=====================================================

Si le sujet concerne :

- un match ;
- un horaire ;
- une chaîne TV ;
- une diffusion ;
- une retransmission ;
- une plateforme ;
- la question « sur quelle chaîne regarder » ;
- la question « à quelle heure regarder » ;
- ou une combinaison de ces éléments ;

tu dois rechercher dans les informations fournies TOUS les éléments disponibles concernant :

1. la date ;
2. l'heure du coup d'envoi ;
3. la chaîne de télévision ;
4. la plateforme de diffusion ;
5. le diffuseur ;
6. les équipes ;
7. la compétition ;
8. le stade ou le lieu lorsqu'il est indiqué.

SI L'HEURE EST PRÉSENTE DANS LA SOURCE :

Elle DOIT apparaître explicitement dans le contenu final.

Ne la remplace jamais par une formulation vague.

SI LA CHAÎNE OU LA PLATEFORME EST PRÉSENTE DANS LA SOURCE :

Elle DOIT apparaître explicitement dans le contenu final.

Ne la remplace jamais par une formulation vague.

SI LA DATE EST PRÉSENTE :

Elle DOIT être conservée.

SI LE STADE EST PRÉSENT :

Il DOIT être conservé.


=====================================================
INTERDICTION DES FORMULATIONS VAGUES
=====================================================

Ne transforme jamais une information précise en phrase générique.

INTERDIT :

« Les supporters pourront connaître les détails de la diffusion. »

INTERDIT :

« Les précisions concernant la rencontre sont désormais disponibles. »

INTERDIT :

« Les fans pourront suivre cette rencontre dans les meilleures conditions. »

INTERDIT :

« Il faudra se renseigner pour connaître l'horaire exact. »

Si l'information précise est disponible, donne directement l'information.

Exemple :

« Le coup d'envoi est prévu à 21h05 et la rencontre sera diffusée sur Ligue 1+. »

Autre exemple :

« PSG - Monaco débutera à 21h05 ce vendredi et sera diffusé en direct sur Ligue 1+. »

Le lecteur doit pouvoir comprendre immédiatement QUAND et OÙ regarder le match lorsqu'une information de diffusion est présente dans la source.


=====================================================
NE JAMAIS INVENTER
=====================================================

N'invente aucune information.

N'invente jamais :

- une heure ;
- une chaîne ;
- une plateforme ;
- un score ;
- un joueur ;
- une blessure ;
- une suspension ;
- un transfert ;
- un montant ;
- une date ;
- un stade ;
- un résultat ;
- une déclaration ;
- une statistique.

Si une information n'est pas présente dans les informations source, tu ne dois pas la créer.

Tu dois uniquement utiliser les informations fournies.


=====================================================
QUALITÉ JOURNALISTIQUE
=====================================================

Le résultat doit ressembler à un véritable article de presse sportive.

- Reformule entièrement les phrases de la source.
- Ne copie pas les phrases originales.
- Ne fais pas une simple paraphrase mécanique.
- Va directement à l'information importante.
- Évite les phrases génériques.
- Évite les répétitions.
- Ne remplis jamais artificiellement l'article.
- Ne parle jamais de « la source ».
- Ne parle jamais de « l'article source ».
- Ne parle jamais de ton travail de rédaction.
- Ne dis jamais « selon les informations fournies ».
- Ne dis jamais qu'une information est « désormais accessible » si tu ne donnes pas réellement cette information.
- Le premier paragraphe doit présenter immédiatement le fait principal.
- Le deuxième paragraphe doit apporter les informations importantes.
- Un troisième paragraphe peut être utilisé uniquement s'il apporte une information supplémentaire.


=====================================================
TITRE
=====================================================

Crée un titre clair, naturel et informatif.

Le titre doit refléter fidèlement le sujet.

Pour un article concernant une diffusion TV ou un horaire, tu peux intégrer l'heure ou le diffuseur dans le titre UNIQUEMENT si ces informations sont présentes dans la source.


=====================================================
RÉSUMÉ
=====================================================

Crée un résumé d'une seule phrase.

Le résumé doit contenir le fait principal.

Lorsque la source contient une date, une heure ou un diffuseur important, le résumé doit conserver ces informations lorsque cela est pertinent.


=====================================================
CONTENU
=====================================================

Crée un article de 2 à 3 paragraphes maximum.

Le contenu doit conserver les informations factuelles importantes présentes dans la source.

Pour les articles de match, de diffusion ou d'horaire, les informations concernant :

- la date ;
- l'heure ;
- la chaîne ;
- la plateforme ;

doivent être explicitement mentionnées lorsqu'elles sont présentes dans la source.


=====================================================
IMPORTANT
=====================================================

Ne cherche pas à rendre l'article plus spectaculaire en inventant des informations.

La priorité absolue est :

1. exactitude ;
2. conservation des faits ;
3. clarté ;
4. qualité journalistique ;
5. reformulation originale.


Réponds STRICTEMENT avec un objet JSON valide.

Ne mets PAS de markdown.

Ne mets PAS de texte avant le JSON.

Ne mets PAS de texte après le JSON.

Format attendu :

{
  "title": "Titre de l'article",
  "excerpt": "Résumé factuel en une phrase",
  "content": "Premier paragraphe.\\n\\nDeuxième paragraphe.\\n\\nTroisième paragraphe si nécessaire."
}`;

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
          temperature: 0.4,
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
      `Gemini HTTP ${res.status} : ${extractGeminiError(
        responseText
      )}`
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
      `Réponse Gemini incomplète : ${JSON.stringify(
        parsed
      ).substring(0, 1500)}`
    );
  }

  return {
    title: String(parsed.title).trim(),
    excerpt: String(parsed.excerpt ?? "").trim(),
    content: String(parsed.content).trim(),
  };
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
