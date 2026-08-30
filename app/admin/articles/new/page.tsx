"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewArticlePage() {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", content: "", excerpt: "", club: "PSG" });
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!form.title || !form.content) { alert("Titre et contenu sont obligatoires."); return; }
    setSaving(true);
    await fetch("/api/admin/articles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    setSaving(false);
    router.push("/admin/articles");
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 16 }}>Nouvel article</h1>
      <label style={labelStyle}>Titre</label>
      <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Résumé</label>
      <input value={form.excerpt} onChange={(e) => setForm({ ...form, excerpt: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Club</label>
      <input value={form.club} onChange={(e) => setForm({ ...form, club: e.target.value })} style={inputStyle} />
      <label style={labelStyle}>Contenu</label>
      <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={14} style={{ ...inputStyle, fontFamily: "inherit" }} />
      <button onClick={create} disabled={saving} style={{ marginTop: 20, background: "#0f172a", color: "white", border: "none", padding: "10px 18px", borderRadius: 8, fontSize: 14, cursor: "pointer" }}>
        Créer en brouillon
      </button>
    </div>
  );
}

const labelStyle = { display: "block", fontSize: 12, fontWeight: 600, color: "#64748b", marginTop: 14, marginBottom: 4 };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 14 };
