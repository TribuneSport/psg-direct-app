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
      /*
       * On récupère maintenant le contenu de la page source.
       *
       * Le RSS de Google News contient souvent un titre et une
       * description trop courte. La page source peut contenir
       * les informations précises : heure, chaîne, joueurs,
       * absences, lieu, montant, etc.
       */
      const sourceContent = await fetchSourceArticle(
        selectedItem.link
      );

      const rewritten = await rewriteWithGemini(
        selectedItem.title,
        selectedItem.description,
        sourceContent
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
        sourceContentRetrieved: sourceContent.length > 0,
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

/**
 * Récupère le contenu texte de la page source.
 *
 * On essaie de rester léger pour ne pas dépasser la limite
 * de temps du cron.
 */
async function fetchSourceArticle(url: string): Promise<string> {
  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 7000);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(
        `Page source inaccessible HTTP ${res.status} : ${url}`
      );

      return "";
    }

    const html = await res.text();

    if (!html) {
      return "";
    }

    const content = extractMainText(html);

    /*
     * Limite volontaire pour éviter d'envoyer des milliers
     * de caractères inutiles à Gemini.
     */
    return content.substring(0, 12000);
  } catch (error) {
    console.warn(
      "Impossible de récupérer la page source :",
      error instanceof Error ? error.message : String(error)
    );

    return "";
  }
}

/**
 * Transforme une page HTML en texte exploitable.
 *
 * On supprime :
 * - scripts
 * - styles
 * - SVG
 * - éléments de navigation
 * - commentaires HTML
 *
 * Puis on récupère le texte visible.
 */
function extractMainText(html: string): string {
  let text = html;

  text = text.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    " "
  );

  text = text.replace(
    /<style\b[^>]*>[\s\S]*?<\/style>/gi,
    " "
  );

  text = text.replace(
    /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
    " "
  );

  text = text.replace(
    /<svg\b[^>]*>[\s\S]*?<\/svg>/gi,
    " "
  );

  text = text.replace(
    /<!--[\s\S]*?-->/g,
    " "
  );

  text = text.replace(
    /<(nav|header|footer|aside|form|button)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " "
  );

  text = text.replace(/<[^>]+>/g, " ");

  text = decodeHtmlEntities(text);

  text = text.replace(/\s+/g, " ").trim();

  return text;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => {
      return String.fromCharCode(Number(code));
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      return String.fromCharCode(parseInt(code, 16));
    });
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
  originalDescription: string,
  sourceContent: string
): Promise<{
  title: string;
  excerpt: string;
  content: string;
}> {
  const prompt = `Tu es un journaliste sportif professionnel spécialisé dans le Paris Saint-Germain.

Ta mission est de transformer les informations fournies ci-dessous en un véritable article de presse sportive ORIGINAL, précis, factuel et naturel en français.

Tu disposes de trois niveaux d'information :

1. TITRE RSS
2. DESCRIPTION RSS
3. CONTENU DE LA PAGE SOURCE

Le contenu de la page source est prioritaire lorsqu'il apporte davantage de détails factuels.

================ TITRE RSS ================

${originalTitle}

================ DESCRIPTION RSS ================

${originalDescription}

================ CONTENU DE LA PAGE SOURCE ================

${sourceContent || "Aucun contenu source supplémentaire disponible."}

========================================================


RÈGLE ABSOLUE : CONSERVE LES FAITS

Tu dois identifier les informations factuelles réellement présentes dans les données fournies avant de rédiger.

Conserve, lorsqu'elles sont présentes :

- les noms des équipes ;
- les noms des joueurs ;
- les noms des entraîneurs ;
- les noms des dirigeants ;
- la compétition ;
- la date ;
- l'heure exacte ;
- la chaîne TV ;
- la plateforme de diffusion ;
- le diffuseur ;
- le stade ;
- le lieu ;
- le score ;
- les absences ;
- les blessures ;
- les suspensions ;
- les informations de mercato ;
- les montants ;
- les durées de contrat ;
- les dates ;
- les statistiques ;
- les déclarations réellement présentes ;
- toutes les données chiffrées importantes.


========================================================
RÈGLE TRÈS IMPORTANTE : PRIORITÉ AUX INFORMATIONS
========================================================

Si le titre RSS ou la description RSS est vague mais que le contenu de la page source contient une information précise, utilise cette information précise.

Exemple :

Si le RSS indique :

« PSG - Monaco : les détails pour suivre le match »

mais que la page source indique :

« La rencontre aura lieu vendredi 4 septembre à 21h05 et sera diffusée sur Ligue 1+. »

alors l'article final DOIT mentionner :

- vendredi 4 septembre ;
- 21h05 ;
- PSG ;
- Monaco ;
- Ligue 1 ;
- Ligue 1+.

Ne transforme jamais ces informations en phrase vague.


========================================================
ARTICLES MATCH / TV / DIFFUSION
========================================================

Si le sujet concerne un match, une diffusion ou un horaire, cherche en priorité dans toutes les informations disponibles :

1. date ;
2. heure ;
3. chaîne ;
4. plateforme ;
5. diffuseur ;
6. équipes ;
7. compétition ;
8. stade ;
9. lieu.

Lorsqu'une de ces informations est présente dans la source, elle doit être explicitement conservée dans l'article.


========================================================
INTERDICTION DES FORMULATIONS VAGUES
========================================================

INTERDIT :

« Les supporters pourront connaître les détails de la diffusion. »

INTERDIT :

« Les précisions concernant la rencontre sont désormais disponibles. »

INTERDIT :

« Les fans pourront suivre cette rencontre dans les meilleures conditions. »

INTERDIT :

« Les informations concernant la programmation seront à retrouver prochainement. »

Si une information précise est disponible, donne-la directement.

Exemple :

« Le PSG recevra Monaco vendredi 4 septembre à 21h05 au Parc des Princes. La rencontre sera diffusée sur Ligue 1+. »


========================================================
NE JAMAIS INVENTER
========================================================

N'invente absolument aucune information.

Tu ne dois jamais inventer :

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
- une déclaration ;
- une statistique.

Si une information n'est pas présente dans les données fournies, ne l'invente pas.

Si une information est absente, omets-la simplement.


========================================================
QUALITÉ JOURNALISTIQUE
========================================================

Le texte doit ressembler à un véritable article publié sur un média sportif.

- Reformule entièrement les informations.
- Ne copie pas les phrases de la source.
- Ne fais pas une paraphrase mécanique.
- Commence directement par l'information principale.
- Évite les introductions génériques.
- Évite les répétitions.
- Évite les phrases qui ne donnent aucune information.
- Ne remplis jamais artificiellement le texte.
- Ne parle jamais de « la source ».
- Ne parle jamais de « l'article source ».
- Ne parle jamais de ton travail.
- Ne dis jamais « selon les informations fournies ».
- Ne dis jamais « les détails sont désormais accessibles » sans donner les détails.
- Le premier paragraphe doit contenir le fait principal.
- Le deuxième paragraphe doit apporter les informations complémentaires.
- Un troisième paragraphe est autorisé uniquement s'il apporte une information réellement utile.


========================================================
TITRE
========================================================

Crée un titre clair, naturel et informatif.

Le titre doit refléter le fait principal.

Pour un article concernant un match ou une diffusion, le titre peut intégrer :

- la date ;
- l'heure ;
- la chaîne ;

uniquement lorsque ces informations sont réellement présentes dans les données.


========================================================
RÉSUMÉ
========================================================

Crée un résumé d'une seule phrase.

Il doit présenter immédiatement le fait principal.

Lorsque la date, l'heure ou le diffuseur sont des informations centrales, conserve-les dans le résumé.


========================================================
CONTENU
========================================================

Crée un article de 2 à 3 paragraphes maximum.

Le premier paragraphe doit donner immédiatement l'information principale.

Le deuxième paragraphe doit apporter les détails importants.

Le troisième paragraphe ne doit être utilisé que s'il existe une information supplémentaire réellement utile.

Pour un article de match ou de diffusion, ne laisse jamais le lecteur chercher inutilement l'heure ou la chaîne lorsqu'elles sont présentes dans les données.


========================================================
OBJECTIF
========================================================

L'article doit être :

- précis ;
- informatif ;
- naturel ;
- original ;
- lisible ;
- journalistique ;
- factuel.

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
