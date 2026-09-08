async function generateArticle(
  sources: EnrichedSource[],
  expandExisting = false,
  existingArticle?: {
    title: string;
    excerpt: string;
    content: string;
  },
): Promise<GeneratedArticle | null> {
  const sourceMaterial = sources
    .map((source, index) => {
      return `
===== SOURCE ${index + 1} =====
Source : ${source.source}
Titre : ${source.title}
URL : ${source.url}

CONTENU ENRICHI :
${source.enrichedContent || source.description || ""}
`;
    })
    .join("\n\n");

  const expansionContext =
    expandExisting && existingArticle
      ? `
===== BROUILLON EXISTANT À AMÉLIORER =====

Titre :
${existingArticle.title}

Extrait :
${existingArticle.excerpt}

Article :
${existingArticle.content}

INSTRUCTION IMPORTANTE :
Le brouillon ci-dessus est insuffisant en longueur ou en profondeur.

Tu dois LE CONSERVER comme base et l'enrichir fortement.

Ne recommence pas l'article depuis zéro.

Tu dois :
- conserver les faits déjà présents lorsqu'ils sont corrects ;
- ajouter les informations factuelles présentes dans les sources ;
- développer les explications et le contexte ;
- ajouter les informations sur la date, l'heure, le stade, la diffusion TV, les compositions, les absences, les blessures, les déclarations, le contexte sportif ou tout autre élément réellement présent dans les sources ;
- supprimer les répétitions ;
- améliorer les transitions ;
- produire un véritable article de presse sportive ;
- atteindre idéalement 600 à 800 mots ;
- ne jamais inventer une information absente des sources.

Le résultat doit être nettement plus complet que le brouillon existant.
`
      : "";

  const prompt = `
Tu es le rédacteur en chef de PSG Direct, un média français spécialisé exclusivement dans le Paris Saint-Germain.

Ta mission est de rédiger UN ARTICLE DE PRESSE SPORTIVE ORIGINAL à partir des sources fournies.

${expansionContext}

===== SOURCES DISPONIBLES =====

${sourceMaterial}

===== RÈGLES ÉDITORIALES ABSOLUES =====

1. Tu dois utiliser uniquement les informations réellement présentes dans les sources.

2. Tu ne dois JAMAIS inventer :
- une date ;
- une heure ;
- un score ;
- une composition ;
- un joueur absent ;
- une blessure ;
- une suspension ;
- une chaîne TV ;
- un stade ;
- un arbitre ;
- une déclaration ;
- une statistique ;
- une information de transfert ;
- ou quelque autre information factuelle.

3. Si une information n'est pas présente dans les sources, ne l'invente pas.

4. Lorsque plusieurs sources parlent du même événement, fusionne leurs informations en UN SEUL article.

5. Ne fais jamais une simple succession de résumés des sources.

6. L'article doit avoir une vraie structure journalistique :
- titre informatif ;
- introduction ;
- développement ;
- contexte ;
- informations pratiques lorsque disponibles ;
- conclusion.

7. Privilégie les faits concrets aux phrases génériques.

8. Lorsque plusieurs sources confirment la même information, tu peux la présenter comme un fait établi.

9. Lorsque seule une source rapporte une information, attribue-la clairement à cette source lorsque cela est nécessaire.

10. Ne mentionne pas "les sources indiquent" à chaque phrase.

11. Ne fais pas de commentaire sur ton processus de rédaction.

12. Ne parle pas de toi.

13. Ne mentionne jamais que tu es une IA.

14. Le texte doit être en français naturel, journalistique et fluide.

15. L'article doit idéalement contenir entre 600 et 800 mots.

16. Si les sources contiennent suffisamment d'informations, exploite-les réellement afin d'atteindre cette longueur.

17. Ne remplis jamais artificiellement l'article avec des phrases vagues pour atteindre le nombre de mots.

18. Chaque paragraphe doit apporter une information ou un contexte utile.

===== FORMAT DE RÉPONSE OBLIGATOIRE =====

Retourne UNIQUEMENT un objet JSON valide avec exactement ces champs :

{
  "title": "titre de l'article",
  "excerpt": "résumé de 2 à 3 phrases",
  "content": "article complet",
  "seoTitle": "titre SEO",
  "seoDescription": "description SEO"
}

Aucun Markdown autour du JSON.
Aucun texte avant le JSON.
Aucun texte après le JSON.
`;

  try {
    const firstResult = await callGemini(prompt);

    if (!firstResult) {
      return null;
    }

    const parsed = parseGeminiJson(firstResult);

    if (!parsed || !isValidGeminiArticle(parsed)) {
      return null;
    }

    const normalized = normalizeArticle(parsed);

    return normalized;
  } catch (error) {
    console.error("Gemini generation error:", getErrorMessage(error));
    return null;
  }
}
