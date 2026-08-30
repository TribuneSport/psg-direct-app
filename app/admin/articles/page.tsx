"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Article = {
  id: string; title: string; slug: string; club: string;
  status: "DRAFT" | "PUBLISHED" | "UNPUBLISHED"; isAiGenerated: boolean; createdAt: string;
};

const STATUS_LABELS: Record<string, string> = { DRAFT: "Brouillon", PUBLISHED: "Publié", UNPUBLISHED: "Dépublié" };
const STATUS_COLORS: Record<string, string> = { DRAFT: "#f59e0b", PUBLISHED: "#22c55e", UNPUBLISHED: "#94a3b8" };

export default function ArticlesAdminPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<string>("DRAFT");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadArticles() {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "ALL") params.set("status", statusFilter);
    if (search) params.set("search", search);
    const res = await fetch(`/api/admin/articles?${params.toString()}`);
    const data = await res.json();
    setArticles(data.articles ?? []);
    setSelected(new Set());
    setLoading(false);
  }

  useEffect(() => { loadArticles(); }, [statusFilter]); // eslint-disable-line

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(selected.size === articles.length ? new Set() : new Set(articles.map((a) => a.id)));
  }
  async function runBulkAction(action: "publish" | "unpublish" | "delete") {
    if (selected.size === 0) return;
    if (action === "delete" && !confirm(`Supprimer ${selected.size} article(s) ?`)) return;
    await fetch("/api/admin/articles/bulk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selected), action }),
    });
    loadArticles();
  }

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Articles PSG — Backoffice</h1>
        <Link href="/admin/articles/new" style={{ background: "#0f172a", color: "white", padding: "8px 16px", borderRadius: 8, textDecoration: "none", fontSize: 14 }}>
          + Nouvel article
        </Link>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {["ALL", "DRAFT", "PUBLISHED", "UNPUBLISHED"].map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: "6px 14px", borderRadius: 20, border: "1px solid #e2e8f0",
            background: statusFilter === s ? "#0f172a" : "white", color: statusFilter === s ? "white" : "#0f172a",
            fontSize: 13, cursor: "pointer",
          }}>
            {s === "ALL" ? "Tous" : STATUS_LABELS[s]}
          </button>
        ))}
        <input placeholder="Rechercher un titre..." value={search} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadArticles()}
          style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, minWidth: 220 }} />
      </div>

      {selected.size > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", background: "#f1f5f9", padding: "10px 14px", borderRadius: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.size} sélectionné(s)</span>
          <button onClick={() => runBulkAction("publish")} style={btnStyle("#22c55e")}>Publier</button>
          <button onClick={() => runBulkAction("unpublish")} style={btnStyle("#94a3b8")}>Dépublier</button>
          <button onClick={() => runBulkAction("delete")} style={btnStyle("#ef4444")}>Supprimer</button>
        </div>
      )}

      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", background: "#f8fafc", fontSize: 12, fontWeight: 600, color: "#64748b" }}>
          <input type="checkbox" checked={articles.length > 0 && selected.size === articles.length} onChange={toggleAll} style={{ marginRight: 12 }} />
          <span style={{ flex: 1 }}>TITRE</span>
          <span style={{ width: 90 }}>CLUB</span>
          <span style={{ width: 100 }}>STATUT</span>
        </div>
        {loading && <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>Chargement...</div>}
        {!loading && articles.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "#94a3b8" }}>Aucun article dans ce filtre.</div>}
        {articles.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderTop: "1px solid #f1f5f9" }}>
            <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} style={{ marginRight: 12 }} />
            <Link href={`/admin/articles/${a.id}`} style={{ flex: 1, color: "#0f172a", textDecoration: "none", fontSize: 14, fontWeight: 500 }}>
              {a.title} {a.isAiGenerated && <span style={{ fontSize: 11, color: "#94a3b8" }}>(IA)</span>}
            </Link>
            <span style={{ width: 90, fontSize: 13, color: "#64748b" }}>{a.club}</span>
            <span style={{ width: 100, fontSize: 12, fontWeight: 600, color: STATUS_COLORS[a.status] }}>{STATUS_LABELS[a.status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function btnStyle(color: string) {
  return { background: color, color: "white", border: "none", padding: "6px 12px", borderRadius: 6, fontSize: 13, cursor: "pointer" } as const;
}
