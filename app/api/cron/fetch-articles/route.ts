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
       * Récupération du véritable contenu de la page source.
       *
       * IMPORTANT :
       * Si nous ne récupérons pas suffisamment de contenu,
       * nous refusons de générer l'article.
       *
       * Cela évite que Gemini remplisse les trous avec
       * des phrases génériques ou des informations inventées.
       */

      const sourceContent = await fetchSourceArticle(
        selectedItem.link
      );

      if (sourceContent.length < 500) {
        throw new Error(
          `Contenu source insuffisant (${sourceContent.length} caractères). Article non créé pour éviter une génération imprécise.`
        );
      }

      const rewritten = await rewriteWithGemini(
        selectedItem.title,
        selectedItem.description,
        sourceContent
      );

      /*
       * Vérification supplémentaire :
       * on refuse un article trop court.
       */

      if (rewritten.content.length < 300) {
        throw new Error(
          "Article Gemini trop court. Article non créé."
        );
      }

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
        sourceContentRetrieved: true,
        sourceContentLength: sourceContent.length,
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
 * Récupère le véritable contenu éditorial de la page source.
 *
 * Ordre de priorité :
 *
 * 1. JSON-LD avec articleBody
 * 2. balise <article>
 * 3. balise <main>
 * 4. fallback sur le HTML visible
 *
 * On limite le résultat à 12000 caractères.
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
        "Accept-Language":
          "fr-FR,fr;q=0.9,en;q=0.8",
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

    /*
     * Première méthode :
     * chercher articleBody dans les données JSON-LD.
     *
     * C'est souvent la méthode la plus propre car les sites
     * de presse placent directement le contenu de l'article
     * dans leur structured data.
     */
    const jsonLdContent = extractArticleBodyFromJsonLd(html);

    if (jsonLdContent.length >= 500) {
      console.log(
        `Source récupérée via JSON-LD : ${jsonLdContent.length} caractères`
      );

      return jsonLdContent.substring(0, 12000);
    }

    /*
     * Deuxième méthode :
     * chercher le contenu dans <article>.
     */
    const articleContent = extractElementText(
      html,
      "article"
    );

    if (articleContent.length >= 500) {
      console.log(
        `Source récupérée via <article> : ${articleContent.length} caractères`
      );

      return articleContent.substring(0, 12000);
    }

    /*
     * Troisième méthode :
     * chercher le contenu dans <main>.
     */
    const mainContent = extractElementText(
      html,
      "main"
    );

    if (mainContent.length >= 500) {
      console.log(
        `Source récupérée via <main> : ${mainContent.length} caractères`
      );

      return mainContent.substring(0, 12000);
    }

    /*
     * Dernière tentative :
     * récupération du texte visible général.
     */
    const fallbackContent = extractMainText(html);

    if (fallbackContent.length >= 500) {
      console.log(
        `Source récupérée via fallback HTML : ${fallbackContent.length} caractères`
      );

      return fallbackContent.substring(0, 12000);
    }

    console.warn(
      `Contenu source insuffisant après extraction : ${fallbackContent.length} caractères`
    );

    return "";
  } catch (error) {
    console.warn(
      "Impossible de récupérer la page source :",
      error instanceof Error
        ? error.message
        : String(error)
    );

    return "";
  }
}

/**
 * Cherche articleBody dans les blocs JSON-LD.
 *
 * Exemple recherché :
 *
 * {
 *   "@type": "NewsArticle",
 *   "articleBody": "..."
 * }
 */
function extractArticleBodyFromJsonLd(
  html: string
): string {
  const matches = html.match(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi
  );

  if (!matches) {
    return "";
  }

  for (const block of matches) {
    const jsonText = block
      .replace(
        /<script\b[^>]*>/i,
        ""
      )
      .replace(
        /<\/script>\s*$/i,
        ""
      )
      .trim();

    try {
      const data = JSON.parse(
        decodeHtmlEntities(jsonText)
      );

      const articleBody = findArticleBody(data);

      if (articleBody.length >= 500) {
        return cleanExtractedText(articleBody);
      }
    } catch {
      /*
       * Certains sites ont un JSON-LD légèrement invalide.
       * On continue avec les autres méthodes.
       */
    }
  }

  return "";
}

/**
 * Cherche récursivement articleBody dans :
 *
 * - un objet ;
 * - @graph ;
 * - un tableau d'objets.
 */
function findArticleBody(
  data: unknown
): string {
  if (!data) {
    return "";
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findArticleBody(item);

      if (result.length >= 500) {
        return result;
      }
    }

    return "";
  }

  if (
    typeof data !== "object" ||
    data === null
  ) {
    return "";
  }

  const obj = data as Record<string, unknown>;

  if (
    typeof obj.articleBody === "string" &&
    obj.articleBody.trim().length >= 500
  ) {
    return obj.articleBody;
  }

  if (obj["@graph"]) {
    const graphResult = findArticleBody(
      obj["@graph"]
    );

    if (graphResult.length >= 500) {
      return graphResult;
    }
  }

  for (const value of Object.values(obj)) {
    if (
      typeof value === "object" &&
      value !== null
    ) {
      const result = findArticleBody(value);

      if (result.length >= 500) {
        return result;
      }
    }
  }

  return "";
}

/**
 * Extrait le texte d'une balise HTML donnée.
 */
function extractElementText(
  html: string,
  tagName: string
): string {
  const regex = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );

  const match = html.match(regex);

  if (!match) {
    return "";
  }

  return cleanExtractedText(
    removeUnwantedHtml(match[1])
  );
}

/**
 * Nettoyage du contenu extrait d'un article.
 */
function cleanExtractedText(
  text: string
): string {
  let cleaned = text;

  cleaned = cleaned
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\t+/g, " ");

  cleaned = cleaned.replace(
    /\s+/g,
    " "
  );

  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * Supprime les éléments HTML inutiles.
 */
function removeUnwantedHtml(
  html: string
): string {
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

  text = text.replace(
    /<[^>]+>/g,
    " "
  );

  text = decodeHtmlEntities(text);

  return text;
}

/**
 * Fallback : transforme la page HTML complète
 * en texte visible.
 */
function extractMainText(
  html: string
): string {
  return cleanExtractedText(
    removeUnwantedHtml(html)
  );
}

function decodeHtmlEntities(
  text: string
): string {
  return text
    .replace(
      /&nbsp;/gi,
      " "
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
      /&#39;/gi,
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
      /&#x27;/gi,
      "'"
    )
    .replace(
      /&#x2F;/gi,
      "/"
    )
    .replace(
      /&#(\d+);/g,
      (_, code) => {
        return String.fromCharCode(
          Number(code)
        );
      }
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, code) => {
        return String.fromCharCode(
          parseInt(code, 16)
        );
      }
    );
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

  return match
    ? match[1]
    : "";
}

function cleanText(
  text: string
): string {
  return text
    .replace(
      "<![CDATA[",
      ""
    )
    .replace(
      "]]>",
      ""
    )
    .replace(
      /<[^>]+>/g,
      ""
    )
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

Tu dois rédiger un véritable article journalistique français à partir d'une source fournie.

IMPORTANT :

Le CONTENU DE LA PAGE SOURCE est la source principale.

Le TITRE RSS et la DESCRIPTION RSS servent uniquement à compléter ou identifier le sujet.

Tu dois d'abord identifier mentalement les faits présents dans la source, puis rédiger l'article.

========================================================
TITRE RSS
========================================================

${originalTitle}

========================================================
DESCRIPTION RSS
========================================================

${originalDescription}

========================================================
CONTENU DE LA PAGE SOURCE
========================================================

${sourceContent}

========================================================
RÈGLE ABSOLUE : NE JAMAIS INVENTER
========================================================

Tu ne dois utiliser que les informations réellement présentes dans les données fournies.

Tu ne dois jamais inventer :

- un joueur ;
- un entraîneur ;
- une déclaration ;
- une date ;
- une heure ;
- un score ;
- une compétition ;
- une chaîne ;
- une plateforme ;
- un stade ;
- une blessure ;
- une suspension ;
- un transfert ;
- un montant ;
- une statistique ;
- une information de mercato.

Si une information n'est pas présente dans la source, ne l'ajoute pas.

========================================================
EXTRACTION DES FAITS
========================================================

Avant de rédiger, identifie les faits réellement présents concernant :

- le PSG ;
- les adversaires ;
- les joueurs ;
- les entraîneurs ;
- les dirigeants ;
- les matchs ;
- les compétitions ;
- les résultats ;
- les performances ;
- les blessures ;
- les absences ;
- les suspensions ;
- le mercato ;
- les transferts ;
- les déclarations ;
- les prochaines échéances ;
- les dates ;
- les horaires ;
- les chaînes ;
- les plateformes ;
- les statistiques ;
- les montants ;
- les contrats.

Tu dois privilégier les informations concrètes plutôt que les généralités.

========================================================
INTERDICTION DES ARTICLES GÉNÉRIQUES
========================================================

Ne rédige jamais un article rempli de phrases comme :

« Le PSG aborde ses prochaines échéances avec ambition. »

« Le club de la capitale veut retrouver une dynamique positive. »

« Les Parisiens devront afficher leurs qualités. »

« Cette rencontre suscite beaucoup d'attentes. »

« Les supporters attendent avec impatience cette rencontre. »

Ces phrases ne doivent être utilisées que si elles sont directement justifiées par un fait précis présent dans la source.

Chaque paragraphe doit apporter une information concrète provenant de la source.

========================================================
MÉTHODE DE RÉDACTION
========================================================

Le premier paragraphe doit répondre immédiatement à :

QUOI ?

Le deuxième paragraphe doit apporter les informations importantes permettant de comprendre :

QUI ?
QUAND ?
OÙ ?
COMMENT ?
POURQUOI ?

selon les informations réellement disponibles.

Un troisième paragraphe peut être utilisé uniquement s'il apporte un fait supplémentaire important.

========================================================
INFORMATIONS CHIFFRÉES
========================================================

Toutes les informations chiffrées importantes présentes dans la source doivent être conservées.

Par exemple :

- date ;
- heure ;
- score ;
- nombre de buts ;
- nombre de matchs ;
- montant ;
- durée ;
- classement ;
- statistiques.

Ne remplace jamais une donnée précise par une formulation vague.

========================================================
DÉCLARATIONS
========================================================

Si la source contient une déclaration précise d'un joueur, entraîneur ou dirigeant, conserve son sens exact en la reformulant.

N'invente aucune citation.

Ne présente jamais une opinion de Gemini comme une déclaration réelle.

========================================================
ARTICLE ORIGINAL
========================================================

Reformule les informations avec un style journalistique naturel.

Ne copie pas les phrases de la source.

Ne mentionne jamais :

- « la source » ;
- « l'article source » ;
- « les informations fournies » ;
- « selon les données » ;
- « d'après le texte fourni ».

Le lecteur doit avoir l'impression de lire un article sportif normalement rédigé.

========================================================
TITRE
========================================================

Crée un titre informatif basé sur le fait principal.

Le titre doit éviter les formulations artificiellement sensationnalistes.

Il doit permettre au lecteur de comprendre immédiatement le sujet.

========================================================
RÉSUMÉ
========================================================

Une seule phrase.

Elle doit présenter le fait principal avec les informations les plus importantes.

========================================================
CONTENU
========================================================

2 à 3 paragraphes maximum.

Chaque paragraphe doit apporter des informations concrètes.

Ne remplis jamais artificiellement l'article.

Si la source contient beaucoup d'informations, sélectionne les plus importantes.

========================================================
CONTRÔLE FINAL
========================================================

Avant de répondre, vérifie mentalement :

1. Est-ce que chaque information importante vient réellement de la source ?
2. Ai-je inventé une information ?
3. Ai-je utilisé des phrases génériques sans valeur ?
4. Ai-je conservé les noms propres ?
5. Ai-je conservé les chiffres ?
6. Ai-je conservé les dates et horaires lorsqu'ils existent ?
7. Ai-je conservé les informations de diffusion lorsqu'elles existent ?
8. Est-ce que le premier paragraphe donne immédiatement le fait principal ?

Si la réponse à une question est non, corrige l'article avant de répondre.

========================================================
FORMAT DE RÉPONSE
========================================================

Réponds STRICTEMENT avec un objet JSON valide.

Aucun markdown.

Aucun texte avant le JSON.

Aucun texte après le JSON.

Format :

{
  "title": "Titre informatif",
  "excerpt": "Résumé factuel en une phrase",
  "content": "Premier paragraphe factuel.\\n\\nDeuxième paragraphe factuel.\\n\\nTroisième paragraphe uniquement si nécessaire."
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
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  const responseText = await res.text();

  if (!res.ok) {
    console.error(
      `Gemini HTTP ${res.status}:`,
      responseText.substring(
        0,
        2000
      )
    );

    throw new Error(
      `Gemini HTTP ${res.status} : ${extractGeminiError(
        responseText
      )}`
    );
  }

  let data: any;

  try {
    data = JSON.parse(
      responseText
    );
  } catch {
    throw new Error(
      `Réponse Gemini impossible à analyser : ${responseText.substring(
        0,
        1000
      )}`
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";

  if (!text) {
    const finishReason =
      data?.candidates?.[0]?.finishReason ??
      "inconnu";

    throw new Error(
      `Gemini n'a retourné aucun texte. finishReason=${finishReason}`
    );
  }

  const cleaned = text
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

  let parsed: {
    title?: string;
    excerpt?: string;
    content?: string;
  };

  try {
    parsed = JSON.parse(
      cleaned
    );
  } catch {
    throw new Error(
      `JSON Gemini invalide : ${cleaned.substring(
        0,
        1500
      )}`
    );
  }

  if (
    !parsed.title ||
    !parsed.content
  ) {
    throw new Error(
      `Réponse Gemini incomplète : ${JSON.stringify(
        parsed
      ).substring(0, 1500)}`
    );
  }

  return {
    title: String(
      parsed.title
    ).trim(),
    excerpt: String(
      parsed.excerpt ?? ""
    ).trim(),
    content: String(
      parsed.content
    ).trim(),
  };
}

function extractGeminiError(
  responseText: string
): string {
  try {
    const data = JSON.parse(
      responseText
    );

    return (
      data?.error?.message ??
      data?.error?.status ??
      responseText.substring(
        0,
        1000
      )
    );
  } catch {
    return responseText.substring(
      0,
      1000
    );
  }
}

function slugify(
  title: string
): string {
  return (
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
      ) +
    "-" +
    Date.now().toString(36)
  );
}
