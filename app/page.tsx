import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatRelativeDate(date: Date | null) {
  if (!date) return "";

  const diffMinutes = Math.round(
    (date.getTime() - Date.now()) / 60000
  );

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

const navigation = [
  { label: "ACCUEIL", href: "/" },
  { label: "ACTUALITÉS", href: "/actualites" },
  { label: "MATCHS", href: "/matchs" },
  { label: "CALENDRIER", href: "/calendrier" },
  { label: "CLASSEMENT", href: "/classement" },
  { label: "ÉQUIPE", href: "/equipe" },
  { label: "JOUEURS", href: "/joueurs" },
  { label: "MERCATO", href: "/mercato" },
];

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
        <header style={styles.header}>
          <Link href="/" style={styles.logoLink}>
            <div style={styles.logoMark}>
              <span style={styles.logoP}>P</span>
              <span style={styles.logoS}>S</span>
              <span style={styles.logoG}>G</span>
            </div>

            <div style={styles.logoText}>
              <strong style={styles.logoTitle}>PSG DIRECT</strong>

              <span style={styles.logoSubtitle}>
                L’actualité du Paris Saint-Germain
              </span>
            </div>
          </Link>

          <Link
            href="/admin/articles"
            style={styles.adminButton}
            aria-label="Accéder au backoffice"
          >
            <span style={styles.adminIcon}>⚙</span>
          </Link>
        </header>

        <nav
          style={styles.navigation}
          aria-label="Navigation principale"
        >
          <div style={styles.navigationInner}>
            {navigation.map((item, index) => (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  ...styles.navItem,
                  ...(index === 0
                    ? styles.navItemActive
                    : {}),
                }}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>

        <section style={styles.matchSection}>
          <div style={styles.matchHeader}>
            <div>
              <span style={styles.matchLabel}>
                PSG DIRECT
              </span>

              <span style={styles.matchCompetition}>
                PROCHAIN RENDEZ-VOUS
              </span>
            </div>

            <span style={styles.liveBadge}>
              LIVE
            </span>
          </div>

          <div style={styles.matchMain}>
            <div style={styles.team}>
              <div style={styles.teamBadge}>
                PSG
              </div>

              <strong>Paris SG</strong>
            </div>

            <div style={styles.matchCenter}>
              <span style={styles.matchDate}>
                MATCH
              </span>

              <strong style={styles.matchVs}>
                VS
              </strong>

              <span style={styles.matchDate}>
                À VENIR
              </span>
            </div>

            <div style={styles.team}>
              <div style={styles.teamBadgeOpponent}>
                ?
              </div>

              <strong>Adversaire</strong>
            </div>
          </div>

          <Link
            href="/matchs"
            style={styles.matchLink}
          >
            Voir les matchs →
          </Link>
        </section>

        <section style={styles.heroSection}>
          <div style={styles.sectionHeading}>
            <div style={styles.headingAccent} />

            <div>
              <span style={styles.headingSmall}>
                PSG DIRECT
              </span>

              <h2 style={styles.headingTitle}>
                À LA UNE
              </h2>
            </div>
          </div>

          {featuredArticle ? (
            <Link
              href={`/article/${featuredArticle.slug}`}
              style={styles.articleLink}
            >
              <article style={styles.heroArticle}>
                <div style={styles.heroBadgeRow}>
                  <span style={styles.heroBadge}>
                    À LA UNE
                  </span>

                  <span style={styles.heroMeta}>
                    {featuredArticle.club || "PSG"}
                  </span>
                </div>

                <h1 style={styles.heroTitle}>
                  {featuredArticle.title}
                </h1>

                {featuredArticle.excerpt ? (
                  <p style={styles.heroExcerpt}>
                    {featuredArticle.excerpt}
                  </p>
                ) : null}

                <div style={styles.heroFooter}>
                  <span>
                    {formatRelativeDate(
                      featuredArticle.publishedAt ??
                        featuredArticle.createdAt
                    )}
                  </span>

                  <span style={styles.readMore}>
                    Lire l’article →
                  </span>
                </div>
              </article>
            </Link>
          ) : (
            <div style={styles.empty}>
              Aucune actualité publiée pour le moment.
            </div>
          )}
        </section>

        {secondaryArticles.length > 0 && (
          <section style={styles.secondarySection}>
            <div style={styles.sectionHeadingCompact}>
              <div style={styles.headingAccent} />

              <h2 style={styles.headingTitle}>
                LES DERNIÈRES INFOS
              </h2>
            </div>

            <div style={styles.secondaryGrid}>
              {secondaryArticles.map((article) => (
                <Link
                  key={article.id}
                  href={`/article/${article.slug}`}
                  style={styles.articleLink}
                >
                  <article style={styles.secondaryArticle}>
                    <div style={styles.articleTopLine}>
                      <span style={styles.articleCategory}>
                        {article.club || "PSG"}
                      </span>

                      <span style={styles.articleTime}>
                        {formatRelativeDate(
                          article.publishedAt ??
                            article.createdAt
                        )}
                      </span>
                    </div>

                    <h3 style={styles.secondaryTitle}>
                      {article.title}
                    </h3>

                    <span style={styles.articleArrow}>
                      →
                    </span>
                  </article>
                </Link>
              ))}
            </div>
          </section>
        )}

        {latestArticles.length > 0 && (
          <section style={styles.latestSection}>
            <div style={styles.sectionHeading}>
              <div style={styles.headingAccent} />

              <div>
                <span style={styles.headingSmall}>
                  EN CONTINU
                </span>

                <h2 style={styles.headingTitle}>
                  DERNIÈRES ACTUALITÉS
                </h2>
              </div>
            </div>

            <div style={styles.latestList}>
              {latestArticles.map((article, index) => (
                <Link
                  key={article.id}
                  href={`/article/${article.slug}`}
                  style={styles.articleLink}
                >
                  <article style={styles.latestArticle}>
                    <div style={styles.latestNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </div>

                    <div style={styles.latestContent}>
                      <div style={styles.latestMeta}>
                        <span>
                          {article.club || "PSG"}
                        </span>

                        <span>•</span>

                        <span>
                          {formatRelativeDate(
                            article.publishedAt ??
                              article.createdAt
                          )}
                        </span>
                      </div>

                      <h3 style={styles.latestTitle}>
                        {article.title}
                      </h3>
                    </div>

                    <span style={styles.latestArrow}>
                      ›
                    </span>
                  </article>
                </Link>
              ))}
            </div>
          </section>
        )}

        <footer style={styles.footer}>
          <div style={styles.footerBrand}>
            <div style={styles.footerLogo}>
              PSG DIRECT
            </div>

            <span style={styles.footerDescription}>
              Toute l’actualité du Paris Saint-Germain
            </span>
          </div>

          <div style={styles.footerLinks}>
            <Link href="/" style={styles.footerLink}>
              Accueil
            </Link>

            <Link
              href="/actualites"
              style={styles.footerLink}
            >
              Actualités
            </Link>

            <Link
              href="/matchs"
              style={styles.footerLink}
            >
              Matchs
            </Link>

            <Link
              href="/classement"
              style={styles.footerLink}
            >
              Classement
            </Link>
          </div>

          <div style={styles.footerBottom}>
            <span>© PSG DIRECT</span>
            <span>Actualités PSG</span>
          </div>
        </footer>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background:
      "linear-gradient(180deg, #eef1f7 0%, #f5f6f9 45%, #eef1f6 100%)",
    padding: "18px 12px 40px",
    fontFamily: "Arial, Helvetica, sans-serif",
    color: "#071b49",
  },

  container: {
    width: "100%",
    maxWidth: "760px",
    margin: "0 auto",
    background: "#ffffff",
    borderRadius: "16px",
    overflow: "hidden",
    boxShadow:
      "0 8px 35px rgba(7, 27, 73, 0.14)",
  },

  header: {
    minHeight: "78px",
    padding: "12px 18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background:
      "linear-gradient(135deg, #06183f 0%, #0b245e 55%, #071b49 100%)",
  },

  logoLink: {
    display: "flex",
    alignItems: "center",
    gap: "11px",
    color: "#ffffff",
    textDecoration: "none",
    minWidth: 0,
  },

  logoMark: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background:
      "linear-gradient(145deg, #ffffff 0%, #dfe5f0 100%)",
    boxShadow:
      "0 3px 10px rgba(0, 0, 0, 0.22)",
    flexShrink: 0,
    position: "relative",
    overflow: "hidden",
  },

  logoP: {
    color: "#e3062f",
    fontSize: "13px",
    fontWeight: 900,
    position: "absolute",
    left: "8px",
    top: "7px",
  },

  logoS: {
    color: "#071b49",
    fontSize: "14px",
    fontWeight: 900,
    position: "absolute",
    left: "14px",
    top: "14px",
  },

  logoG: {
    color: "#e3062f",
    fontSize: "13px",
    fontWeight: 900,
    position: "absolute",
    right: "7px",
    bottom: "6px",
  },

  logoText: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },

  logoTitle: {
    color: "#ffffff",
    fontSize: "20px",
    lineHeight: 1,
    letterSpacing: "0.6px",
    fontWeight: 900,
  },

  logoSubtitle: {
    marginTop: "5px",
    color: "#aebbd6",
    fontSize: "9px",
    letterSpacing: "0.2px",
    whiteSpace: "nowrap",
  },

  adminButton: {
    width: "34px",
    height: "34px",
    borderRadius: "10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textDecoration: "none",
    background: "rgba(255, 255, 255, 0.08)",
    border:
      "1px solid rgba(255, 255, 255, 0.12)",
    flexShrink: 0,
  },

  adminIcon: {
    color: "#ffffff",
    fontSize: "15px",
  },

  navigation: {
    background: "#ffffff",
    borderBottom: "1px solid #e3e7ee",
    overflowX: "auto",
  },

  navigationInner: {
    display: "flex",
    alignItems: "center",
    minWidth: "max-content",
    padding: "0 10px",
  },

  navItem: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "48px",
    padding: "0 11px",
    color: "#657089",
    textDecoration: "none",
    fontSize: "10px",
    fontWeight: 800,
    letterSpacing: "0.35px",
    whiteSpace: "nowrap",
  },

  navItemActive: {
    color: "#071b49",
  },

  matchSection: {
    margin: "14px 15px 0",
    padding: "14px",
    borderRadius: "13px",
    background:
      "linear-gradient(135deg, #081d4c 0%, #102e68 100%)",
    color: "#ffffff",
    boxShadow:
      "0 5px 16px rgba(7, 27, 73, 0.17)",
  },

  matchHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "13px",
  },

  matchLabel: {
    display: "block",
    color: "#ffffff",
    fontSize: "10px",
    fontWeight: 900,
    letterSpacing: "0.5px",
  },

  matchCompetition: {
    display: "block",
    marginTop: "3px",
    color: "#9eafd0",
    fontSize: "8px",
    fontWeight: 600,
    letterSpacing: "0.5px",
  },

  liveBadge: {
    padding: "5px 9px",
    borderRadius: "999px",
    background: "#e3062f",
    color: "#ffffff",
    fontSize: "9px",
    fontWeight: 900,
    letterSpacing: "0.5px",
  },

  matchMain: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    gap: "10px",
  },

  team: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    minWidth: "95px",
    fontSize: "12px",
  },

  teamBadge: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#ffffff",
    color: "#071b49",
    fontSize: "11px",
    fontWeight: 900,
    border: "3px solid #e3062f",
  },

  teamBadgeOpponent: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255, 255, 255, 0.1)",
    color: "#aebbd6",
    fontSize: "17px",
    fontWeight: 800,
    border:
      "2px solid rgba(255, 255, 255, 0.18)",
  },

  matchCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "3px",
  },

  matchDate: {
    color: "#8fa3c9",
    fontSize: "8px",
    fontWeight: 700,
    letterSpacing: "0.5px",
  },

  matchVs: {
    color: "#ffffff",
    fontSize: "18px",
    fontWeight: 900,
  },

  matchLink: {
    display: "block",
    marginTop: "12px",
    paddingTop: "9px",
    borderTop:
      "1px solid rgba(255, 255, 255, 0.1)",
    color: "#ffffff",
    textAlign: "center",
    textDecoration: "none",
    fontSize: "10px",
    fontWeight: 800,
  },

  heroSection: {
    padding: "0 15px",
  },

  sectionHeading: {
    marginTop: "19px",
    paddingBottom: "10px",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    borderBottom: "1px solid #e5e8ed",
  },

  sectionHeadingCompact: {
    marginBottom: "10px",
    display: "flex",
    alignItems: "center",
    gap: "9px",
  },

  headingAccent: {
    width: "4px",
    height: "30px",
    borderRadius: "3px",
    background:
      "linear-gradient(180deg, #e3062f 0%, #ff4a67 100%)",
    flexShrink: 0,
  },

  headingSmall: {
    display: "block",
    color: "#9aa3b3",
    fontSize: "8px",
    fontWeight: 800,
    letterSpacing: "0.7px",
    marginBottom: "2px",
  },

  headingTitle: {
    margin: 0,
    color: "#071b49",
    fontSize: "13px",
    lineHeight: 1.15,
    fontWeight: 900,
    letterSpacing: "0.2px",
  },

  articleLink: {
    display: "block",
    color: "inherit",
    textDecoration: "none",
  },

  heroArticle: {
    marginTop: "12px",
    padding: "17px",
    borderRadius: "13px",
    background:
      "linear-gradient(145deg, #f7f8fa 0%, #eef1f6 100%)",
    border: "1px solid #e1e5ec",
  },

  heroBadgeRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "10px",
  },

  heroBadge: {
    padding: "4px 7px",
    borderRadius: "4px",
    background: "#e3062f",
    color: "#ffffff",
    fontSize: "8px",
    fontWeight: 900,
    letterSpacing: "0.4px",
  },

  heroMeta: {
    color: "#758096",
    fontSize: "9px",
    fontWeight: 700,
  },

  heroTitle: {
    margin: 0,
    color: "#071b49",
    fontSize: "21px",
    lineHeight: 1.22,
    fontWeight: 900,
    letterSpacing: "-0.3px",
  },

  heroExcerpt: {
    margin: "9px 0 0",
    color: "#68738a",
    fontSize: "12px",
    lineHeight: 1.5,
  },

  heroFooter: {
    marginTop: "14px",
    paddingTop: "10px",
    borderTop: "1px solid #dfe3e9",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    color: "#929bab",
    fontSize: "9px",
    fontWeight: 600,
  },

  readMore: {
    color: "#e3062f",
    fontWeight: 900,
  },

  empty: {
    marginTop: "12px",
    padding: "20px",
    borderRadius: "10px",
    background: "#f5f6f8",
    color: "#68738a",
    fontSize: "12px",
    textAlign: "center",
  },

  secondarySection: {
    marginTop: "19px",
    padding: "0 15px",
  },

  secondaryGrid: {
    display: "grid",
    gridTemplateColumns:
      "repeat(3, minmax(0, 1fr))",
    gap: "8px",
  },

  secondaryArticle: {
    minHeight: "145px",
    padding: "11px",
    borderRadius: "10px",
    border: "1px solid #e1e5eb",
    background: "#ffffff",
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },

  articleTopLine: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  },

  articleCategory: {
    color: "#e3062f",
    fontSize: "8px",
    fontWeight: 900,
    textTransform: "uppercase",
  },

  articleTime: {
    color: "#9aa3b3",
    fontSize: "8px",
  },

  secondaryTitle: {
    margin: "9px 0 22px",
    color: "#071b49",
    fontSize: "12px",
    lineHeight: 1.35,
    fontWeight: 800,
  },

  articleArrow: {
    position: "absolute",
    right: "10px",
    bottom: "8px",
    color: "#e3062f",
    fontSize: "16px",
    fontWeight: 800,
  },

  latestSection: {
    marginTop: "20px",
    padding: "0 15px",
  },

  latestList: {
    marginTop: "10px",
    borderTop: "1px solid #e1e5eb",
  },

  latestArticle: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "12px 2px",
    borderBottom: "1px solid #e1e5eb",
  },

  latestNumber: {
    width: "28px",
    flexShrink: 0,
    color: "#c4cad4",
    fontSize: "10px",
    fontWeight: 900,
  },

  latestContent: {
    flex: 1,
    minWidth: 0,
  },

  latestMeta: {
    display: "flex",
    alignItems: "center",
    gap: "5px",
    color: "#9aa3b3",
    fontSize: "8px",
    fontWeight: 600,
  },

  latestTitle: {
    margin: "4px 0 0",
    color: "#071b49",
    fontSize: "12px",
    lineHeight: 1.35,
    fontWeight: 800,
  },

  latestArrow: {
    color: "#e3062f",
    fontSize: "22px",
    lineHeight: 1,
    fontWeight: 300,
  },

  footer: {
    marginTop: "20px",
    padding: "20px 15px 15px",
    background: "#071b49",
    color: "#ffffff",
  },

  footerBrand: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },

  footerLogo: {
    fontSize: "15px",
    fontWeight: 900,
    letterSpacing: "0.5px",
  },

  footerDescription: {
    color: "#8fa3c9",
    fontSize: "9px",
  },

  footerLinks: {
    display: "flex",
    flexWrap: "wrap",
    gap: "14px",
    marginTop: "15px",
    paddingTop: "12px",
    borderTop:
      "1px solid rgba(255, 255, 255, 0.1)",
  },

  footerLink: {
    color: "#d9e0ed",
    textDecoration: "none",
    fontSize: "9px",
    fontWeight: 700,
  },

  footerBottom: {
    marginTop: "14px",
    paddingTop: "10px",
    borderTop:
      "1px solid rgba(255, 255, 255, 0.07)",
    display: "flex",
    justifyContent: "space-between",
    color: "#7185aa",
    fontSize: "8px",
  },
};
