import { NextRequest, NextResponse } from "next/server";
import Parser from "rss-parser";

const RSS_URL =
  "https://news.google.com/rss/search?q=PSG+Paris+Saint-Germain+football&hl=fr&gl=FR&ceid=FR:fr";

const parser = new Parser();

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
};

function cleanText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/gi, "/");
}

function removeUnwantedHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
}

function htmlToText(html: string): string {
  return cleanText(
    decodeHtmlEntities(
      html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/div>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function extractElementText(
  html: string,
  tagName: string
): string | null {
  const regex = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i"
  );

  const match = html.match(regex);

  if (!match?.[1]) {
    return null;
  }

  const text = htmlToText(match[1]);

  return text || null;
}

function extractArticleBodyFromJsonLd(
  html: string
): { text: string; method: string } {
  const scripts = [
    ...html.matchAll(
      /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ];

  for (const match of scripts) {
    const raw = match[1]?.trim();

    if (!raw) {
      continue;
    }

    try {
      const data = JSON.parse(raw);

      const candidates: any[] = [];

      if (Array.isArray(data)) {
        candidates.push(...data);
      } else if (data && typeof data === "object") {
        candidates.push(data);

        if (Array.isArray(data["@graph"])) {
          candidates.push(...data["@graph"]);
        }
      }

      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") {
          continue;
        }

        const articleBody =
          typeof candidate.articleBody === "string"
            ? candidate.articleBody
            : "";

        if (articleBody.trim().length > 100) {
          return {
            text: cleanText(articleBody),
            method: "json-ld.articleBody",
          };
        }

        const description =
          typeof candidate.description === "string"
            ? candidate.description
            : "";

        if (description.trim().length > 100) {
          return {
            text: cleanText(description),
            method: "json-ld.description",
          };
        }
      }
    } catch {
      // Certains sites possèdent des JSON-LD invalides.
      // On continue avec les autres méthodes.
    }
  }

  return {
    text: "",
    method: "none",
  };
}

function extractSourceContent(
  html: string
): { text: string; method: string } {
  const jsonLd = extractArticleBodyFromJsonLd(html);

  if (jsonLd.text.length > 0) {
    return jsonLd;
  }

  const article = extractElementText(html, "article");

  if (article && article.length > 100) {
    return {
      text: article,
      method: "article",
    };
  }

  const main = extractElementText(html, "main");

  if (main && main.length > 100) {
    return {
      text: main,
      method: "main",
    };
  }

  const cleanedHtml = removeUnwantedHtml(html);
  const fallback = htmlToText(cleanedHtml);

  if (fallback.length > 100) {
    return {
      text: fallback,
      method: "fallback",
    };
  }

  return {
    text: "",
    method: "none",
  };
}

async function fetchSourceDebug(url: string) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 7000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    });

    const contentType =
      response.headers.get("content-type") || "";

    const html = await response.text();

    const extraction = extractSourceContent(html);

    return {
      rssLink: url,
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType,
      htmlLength: html.length,
      extractedLength: extraction.text.length,
      extractionMethod: extraction.method,
      extractedPreview: extraction.text.slice(0, 1000),
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return {
      rssLink: url,
      finalUrl: null,
      status: null,
      statusText: null,
      ok: false,
      contentType: null,
      htmlLength: 0,
      extractedLength: 0,
      extractionMethod: "error",
      extractedPreview: "",
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRssItems(): Promise<RssItem[]> {
  const response = await fetch(RSS_URL, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": "Mozilla/5.0 PSG Direct RSS Reader",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(
      `RSS inaccessible : HTTP ${response.status}`
    );
  }

  const xml = await response.text();

  const feed = await parser.parseString(xml);

  return feed.items as RssItem[];
}

export async function GET(request: NextRequest) {
  try {
    const secret = request.nextUrl.searchParams.get("secret");

    if (!process.env.CRON_SECRET) {
      return NextResponse.json(
        {
          error:
            "CRON_SECRET n'est pas configuré dans les variables d'environnement.",
        },
        { status: 500 }
      );
    }

    if (secret !== process.env.CRON_SECRET) {
      return NextResponse.json(
        {
          error: "Non autorisé.",
        },
        { status: 401 }
      );
    }

    const items = await fetchRssItems();

    if (!items.length) {
      return NextResponse.json({
        checked: 0,
        message: "Aucun article RSS trouvé.",
      });
    }

    /*
     * DIAGNOSTIC UNIQUEMENT
     *
     * On teste le premier article RSS.
     * Aucun article n'est créé.
     * Gemini n'est pas appelé.
     */
    const selectedItem = items[0];

    if (!selectedItem.link) {
      return NextResponse.json({
        checked: items.length,
        error: "Le premier article RSS ne possède aucune URL.",
        rssItem: {
          title: selectedItem.title || null,
          pubDate: selectedItem.pubDate || null,
        },
      });
    }

    const debug = await fetchSourceDebug(
      selectedItem.link
    );

    return NextResponse.json(
      {
        diagnostic: true,
        message:
          "Diagnostic terminé. Aucun article n'a été créé et Gemini n'a pas été appelé.",
        checked: items.length,
        rssItem: {
          title: selectedItem.title || null,
          link: selectedItem.link || null,
          pubDate: selectedItem.pubDate || null,
          description:
            selectedItem.contentSnippet ||
            selectedItem.content ||
            null,
        },
        source: debug,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return NextResponse.json(
      {
        diagnostic: true,
        error: message,
      },
      {
        status: 500,
      }
    );
  }
}
