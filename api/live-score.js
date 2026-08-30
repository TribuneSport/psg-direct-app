// Fonction serverless Vercel indépendante — ne touche à rien de tribune-sport.
// Une fois déployée, elle sera accessible à une adresse du type :
// https://TON-PROJET.vercel.app/api/live-score

export default async function handler(req, res) {
  const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
  const PSG_TEAM_ID = "524"; // confirmé : Paris Saint-Germain FC

  try {
    const today = new Date();
    const dateFrom = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
    const dateTo = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);

    const apiRes = await fetch(
      `https://api.football-data.org/v4/teams/${PSG_TEAM_ID}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { "X-Auth-Token": API_KEY } }
    );

    if (!apiRes.ok) {
      res.status(200).json({ liveScore: null, error: "API indisponible" });
      return;
    }

    const data = await apiRes.json();
    const match = data.matches?.[0];

    if (!match) {
      res.status(200).json({ liveScore: null }); // pas de match aujourd'hui
      return;
    }

    const isHome = match.homeTeam.id.toString() === PSG_TEAM_ID;
    const liveScore = {
      competition: match.competition.name,
      status: mapStatus(match.status),
      minute: match.minute ?? null,
      homeTeam: match.homeTeam.shortName ?? match.homeTeam.name,
      awayTeam: match.awayTeam.shortName ?? match.awayTeam.name,
      homeScore: match.score.fullTime.home ?? match.score.halfTime.home ?? 0,
      awayScore: match.score.fullTime.away ?? match.score.halfTime.away ?? 0,
      isLive: match.status === "IN_PLAY" || match.status === "PAUSED",
      isPsgHome: isHome,
    };

    // Cache 30s pour ménager le quota de l'API (largement suffisant pour 1 match/jour)
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate");
    res.status(200).json({ liveScore });
  } catch (e) {
    res.status(200).json({ liveScore: null, error: "Erreur réseau" });
  }
}

function mapStatus(status) {
  const map = {
    SCHEDULED: "À venir",
    TIMED: "À venir",
    IN_PLAY: "En direct",
    PAUSED: "Mi-temps",
    FINISHED: "Terminé",
    POSTPONED: "Reporté",
    CANCELLED: "Annulé",
  };
  return map[status] ?? status;
}
