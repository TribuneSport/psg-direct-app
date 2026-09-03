"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function EditArticlePage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", content: "", excerpt: "", club: "PSG", status: "DRAFT" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/admin/articles/${params.id}`).then((r) => r.json()).then((data) => {
      if (data.article) setForm(data.article);
      setLoading(false);
    });
  }, [params.id]);

  async function save(publishNow = false) {
    setSaving(true);
    const payload = { ...form, ...(publishNow ? { status: "PUBLISHED" } : {}) };
    await fetch(`/api/admin/articles/${params.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    setSaving(false);
    router.push("/admin/articles");
  }
  async function remove() {
    if (!confirm("Supprimer définitivement cet article ?")) return;
    await fetch(`/api/admin/articles/${params.id}`, { method: "DELETE" });
    router.push("/admin/articles");
  }

  if (loading) return <div style={{ padding: 24 }}>Chargement...</div>;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Modifier l'article</h1>
      <label style={labelStyle}>Titre</label>
      <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Résumé</label>
      <input value={form.excerpt ?? ""} onChange={(e) => setForm({ ...form, excerpt: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Club</label>
      <input value={form.club} onChange={(e) => setForm({ ...form, club: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Contenu</label>
      <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={14} style={{ ...inputStyle, fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <button onClick={() => save(false)} disabled={saving} style={btnStyle("#0f172a")}>Enregistrer (brouillon)</button>
        <button onClick={() => save(true)} disabled={saving} style={btnStyle("#22c55e")}>Enregistrer et publier</button>
        <button onClick={remove} style={{ ...btnStyle("#ef4444"), marginLeft: "auto" }}>Supprimer</button>
      </div>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "#64748b", marginTop: 14, marginBottom: 4 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 14 };
function btnStyle(color: string) {
  return { background: color, color: "white", border: "none", padding: "10px 18px", borderRadius: 8, fontSize: 14, cursor: "pointer" } as const;
}
