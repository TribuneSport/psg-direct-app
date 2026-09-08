import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatRelativeDate(date: Date | null) {
  if (!date) return "";

  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);

  if (Math.abs(diffMinutes) < 1) {
    return "à l’instant";
  }

  if (Math.abs(diffMinutes) < 60) {
    return diffMinutes < 0
      ? `il y a ${Math.abs(diffMinutes)} min`
      : `dans ${diffMinutes} min`;
  }

  const diffHours = Math.round(diffMinutes / 60);

  if (Math.abs(diffHours) < 24) {
    return diffHours < 0
      ? `il y a ${Math.abs(diffHours)} h`
      : `dans ${diffHours} h`;
  }

  const diffDays = Math.round(diffHours / 24);

  return diffDays < 0
    ? `il y a ${Math.abs(diffDays)} j`
    : `dans ${diffDays} j`;
}

export default async function Home() {
  const articles = await prisma.article.findMany({
    where: {
      status: "PUBLISHED",
    },
    orderBy: [
      {
        publishedAt: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
    take: 12,
    select: {
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      club: true,
      publishedAt: true,
      createdAt: true,
    },
  });

  const featuredArticle = articles[0] ?? null;
  const secondaryArticles = articles.slice(1, 4);
  const latestArticles = articles.slice(4);

  return (
    <main style={styles.page}>
      <div style={styles.container}>
        {/* HEADER */}
        <header style={styles.header}>
          <Link href="/" style={styles.logo}>
            PSG DIRECT
          </Link>

          <Link
            href="/admin/articles"
            style={styles.notification}
            aria-label="Accéder au backoffice"
          >
            <span style={styles.bell}>♧</span>
          </Link>
        </header>

        {/* LIVE / MATCH */}
        <section style={styles.matchCard}>
          <div style={styles.matchInfo}>
            <div style={styles.matchCompetition}>Ligue 1 · PSG</div>

            <div style={styles.matchTeams}>
              <strong>PSG</strong>
              <span style={styles.score}>—</span>
              <strong>Actualités</strong>
            </div>
          </div>

          <span style={styles.liveBadge}>LIVE</span>
        </section>

        {/* À LA UNE */}
        <section style={styles.section}>
          <div style={styles.sectionTitle}>
            <span style={styles.redBar} />
            <span>À LA UNE</span>
          </div>

          {featuredArticle ? (
            <Link
              href={`/article/${featuredArticle.slug}`}
              style={styles.articleLink}
            >
              <article style={styles.featuredArticle}>
                <h1 style={styles.featuredTitle}>
                  {featuredArticle.title}
                </h1>

                <div style={styles.meta}>
                  {featuredArticle.club || "PSG"} ·{" "}
                  {formatRelativeDate(
                    featuredArticle.publishedAt ??
                      featuredArticle.createdAt
                  )}
                </div>

                {featuredArticle.excerpt ? (
                  <p style={styles.excerpt}>
                    {featuredArticle.excerpt}
                  </p>
                ) : null}
              </article>
            </Link>
          ) : (
            <div style={styles.empty}>
              Aucune actualité publiée pour le moment.
            </div>
          )}
        </section>

        {/* ARTICLES SECONDAIRES */}
        {secondaryArticles.length > 0 && (
          <section style={styles.newsList}>
            {secondaryArticles.map((article) => (
              <Link
                key={article.id}
                href={`/article/${article.slug}`}
                style={styles.articleLink}
              >
                <article style={styles.article}>
                  <h2 style={styles.articleTitle}>
                    {article.title}
                  </h2>

                  <div style={styles.meta}>
                    {article.club || "PSG"} ·{" "}
                    {formatRelativeDate(
                      article.publishedAt ??
                        article.createdAt
                    )}
                  </div>
                </article>
              </Link>
            ))}
          </section>
        )}

        {/* DERNIÈRES ACTUALITÉS */}
        {latestArticles.length > 0 && (
          <section style={styles.section}>
            <div style={styles.sectionTitle}>
              <span style={styles.redBar} />
              <span>DERNIÈRES ACTUALITÉS</span>
            </div>

            <div style={styles.newsListInner}>
              {latestArticles.map((article) => (
                <Link
                  key={article.id}
                  href={`/article/${article.slug}`}
                  style={styles.articleLink}
                >
                  <article style={styles.article}>
                    <h2 style={styles.articleTitle}>
                      {article.title}
                    </h2>

                    <div style={styles.meta}>
                      {article.club || "PSG"} ·{" "}
                      {formatRelativeDate(
                        article.publishedAt ??
                          article.createdAt
                      )}
                    </div>
                  </article>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* FOOTER */}
        <footer style={styles.footer}>
          <strong>PSG DIRECT</strong>
          <span>Actualités du Paris Saint-Germain</span>
        </footer>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f1f3f7",
    padding: "14px 12px 30px",
    fontFamily:
      "Arial, Helvetica, sans-serif",
    color: "#071b49",
  },

  container: {
    width: "100%",
    maxWidth: "620px",
    margin: "0 auto",
    background: "#ffffff",
    borderRadius: "10px",
    overflow: "hidden",
    boxShadow:
      "0 2px 10px rgba(7, 27, 73, 0.12)",
  },

  header: {
    height: "58px",
    padding: "0 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#0b2055",
  },

  logo: {
    color: "#ffffff",
    textDecoration: "none",
    fontSize: "16px",
    fontWeight: 800,
    letterSpacing: "0.2px",
  },

  notification: {
    width: "30px",
    height: "30px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textDecoration: "none",
  },

  bell: {
    color: "#ff1636",
    fontSize: "23px",
    lineHeight: 1,
    transform: "rotate(180deg)",
  },

  matchCard: {
    margin: "12px 16px 0",
    padding: "10px 12px",
    minHeight: "52px",
    borderLeft: "3px solid #ff1636",
    borderRadius: "0 7px 7px 0",
    background: "#f7f7f8",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },

  matchInfo: {
    minWidth: 0,
  },

  matchCompetition: {
    fontSize: "11px",
    color: "#68738a",
    marginBottom: "3px",
  },

  matchTeams: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    fontSize: "14px",
    color: "#071b49",
  },

  score: {
    color: "#68738a",
    fontWeight: 500,
  },

  liveBadge: {
    flexShrink: 0,
    padding: "4px 9px",
    borderRadius: "999px",
    background: "#ff1636",
    color: "#ffffff",
    fontSize: "10px",
    fontWeight: 800,
  },

  section: {
    padding: "0 16px",
  },

  sectionTitle: {
    marginTop: "16px",
    paddingBottom: "9px",
    borderBottom:
      "1px solid #e1e4e9",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "#68738a",
    fontSize: "11px",
    fontWeight: 500,
    letterSpacing: "0.2px",
  },

  redBar: {
    width: "3px",
    height: "15px",
    borderRadius: "2px",
    background: "#ff1636",
    display: "inline-block",
  },

  articleLink: {
    display: "block",
    color: "inherit",
    textDecoration: "none",
  },

  featuredArticle: {
    padding: "14px 0 14px",
    borderBottom:
      "1px solid #e1e4e9",
  },

  featuredTitle: {
    margin: 0,
    color: "#071b49",
    fontSize: "17px",
    lineHeight: 1.3,
    fontWeight: 800,
  },

  excerpt: {
    margin: "7px 0 0",
    color: "#68738a",
    fontSize: "12px",
    lineHeight: 1.45,
  },

  newsList: {
    padding: "0 16px",
  },

  newsListInner: {
    padding: 0,
  },

  article: {
    padding: "13px 0 12px",
    borderBottom:
      "1px solid #e1e4e9",
  },

  articleTitle: {
    margin: 0,
    color: "#071b49",
    fontSize: "15px",
    lineHeight: 1.3,
    fontWeight: 800,
  },

  meta: {
    marginTop: "5px",
    color: "#8a93a4",
    fontSize: "11px",
    lineHeight: 1.25,
  },

  empty: {
    padding: "20px 0",
    color: "#68738a",
    fontSize: "13px",
  },

  footer: {
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    color: "#8a93a4",
    fontSize: "10px",
    borderTop:
      "1px solid #e1e4e9",
  },
};
