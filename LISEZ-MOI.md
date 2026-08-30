# Backoffice PSG Direct — Installation complète

Ce projet ajoute au dépôt `psg-direct-app` existant : le backoffice
(brouillons, validation, actions en masse), l'API des articles publiés, et
reprend le score en direct déjà en place. Tout reste dans le même projet
Vercel qu'on a déjà déployé — pas de nouveau site à créer.

## Étape 1 — Créer la base de données (gratuite, 2 clics)

1. Va sur ton tableau de bord Vercel, ouvre le projet **psg-direct-app**.
2. Dans le menu, clique sur **Storage**, puis **Create Database**.
3. Choisis **Neon** (Postgres), plan **Free**. Suis les quelques écrans,
   accepte les valeurs par défaut.
4. Une fois créée, Vercel ajoute automatiquement deux variables
   d'environnement à ton projet : `DATABASE_URL` et `DIRECT_URL`. Tu n'as
   rien à copier-coller, c'est fait tout seul.

## Étape 2 — Envoyer tous ces fichiers sur GitHub

1. Va sur `github.com/TribuneSport/psg-direct-app`.
2. Clique sur **Add file** → **Upload files**.
3. Glisse **tous** les fichiers et dossiers de cette archive (respecte bien
   la structure de dossiers : `app/`, `prisma/`, `lib/`, et les fichiers à
   la racine comme `package.json`, `tsconfig.json`).
   ⚠️ Sur GitHub, glisser un dossier entier fonctionne directement (pas
   besoin de le faire fichier par fichier) — glisse le dossier `app` en
   entier, puis `prisma`, puis `lib`, puis les fichiers seuls.
4. En bas de page, clique sur **Commit changes**.

## Étape 3 — Ajouter ta clé API Football-Data.org (si pas déjà fait)

Si tu l'avais déjà ajoutée lors de l'étape du score en direct, tu peux
sauter cette étape. Sinon : Vercel → projet → **Settings** →
**Environment Variables** → ajoute `FOOTBALL_DATA_API_KEY` avec ta clé.

## Étape 4 — Redéployer

1. Retourne sur Vercel, onglet **Deployments**.
2. Le dépôt GitHub étant modifié, un nouveau déploiement démarre
   normalement tout seul après quelques secondes. Sinon, clique sur les
   trois points "..." du dernier déploiement → **Redeploy**.
3. Attends que le statut passe à **Ready** (peut prendre 1 à 3 minutes,
   plus long que la dernière fois car il y a plus de code à construire).

## Étape 5 — Créer les tables dans la base de données

C'est la seule étape qui demande le terminal (une fois, pas plus) :

1. Sur ton PC, ouvre PowerShell dans un dossier **vide** temporaire.
2. Tape :
   ```
   npx prisma --version
   ```
   (accepte l'installation si demandé)
3. Va sur Vercel → projet → **Settings** → **Environment Variables**,
   clique sur l'icône "œil" à côté de `DATABASE_URL` pour voir sa valeur
   complète, et copie-la.
4. Dans PowerShell, tape (Windows) :
   ```
   $env:DATABASE_URL="colle_la_valeur_copiee_ici"
   ```
5. Toujours dans ce même dossier vide, récupère juste le fichier
   `prisma/schema.prisma` de cette archive (télécharge-le, place-le dans un
   sous-dossier `prisma` de ton dossier temporaire), puis tape :
   ```
   npx prisma migrate deploy
   ```
   Ça crée la table `Article` dans ta nouvelle base de données.

Si cette étape 5 te semble trop technique, dis-le moi — je peux te donner
une méthode alternative en cliquant uniquement, directement dans
l'interface Neon.

## Étape 6 — Tester

Ouvre `https://psg-direct-app-1ktj.vercel.app/admin/articles` — tu dois
voir le backoffice, vide pour l'instant (aucun article créé). Clique sur
**+ Nouvel article** pour en créer un premier test.

## ⚠️ Sécurité — à ne pas oublier avant de partager l'app

Cette page `/admin/articles` n'a **aucune protection par mot de passe**.
N'importe qui connaissant l'adresse peut y accéder et publier/supprimer des
articles. Avant de rendre l'app publique, dis-le moi et on ajoutera un mot
de passe simple.
