# API score PSG — déploiement indépendant

Ce dossier est un projet **complètement séparé** de tribune-sport. Il ne
contient qu'une seule route (`/api/live-score`) et sera hébergé à sa propre
adresse. **Aucun risque pour ton site actuel** : ils n'ont rien en commun,
pas même le même hébergement.

## Déploiement (10 minutes, gratuit, sans carte bancaire)

1. Va sur https://vercel.com et crée un compte gratuit (tu peux t'inscrire
   directement avec Google ou GitHub, pas besoin de carte).
2. Une fois connecté, installe l'outil Vercel en ligne de commande. Dans un
   terminal, tape :
   ```
   npm install -g vercel
   ```
3. Place-toi dans ce dossier (`psg-live-score-api`) avec `cd`, puis tape :
   ```
   vercel
   ```
   Ça va te poser quelques questions (répondre par défaut à tout, appuyer
   sur Entrée à chaque fois convient très bien pour un premier essai).
4. Une fois le déploiement terminé, Vercel t'affiche une adresse du type
   `https://psg-live-score-api-xxxx.vercel.app`. **Note cette adresse.**
5. Ajoute ta clé API Football-Data.org en tant que variable d'environnement
   *sur Vercel* (pas dans un fichier local cette fois) :
   ```
   vercel env add FOOTBALL_DATA_API_KEY
   ```
   Colle ta clé quand demandé, choisis "Production" quand on te demande
   l'environnement.
6. Redéploie une dernière fois pour que la variable soit prise en compte :
   ```
   vercel --prod
   ```

## Tester que ça marche

Ouvre dans ton navigateur :
```
https://TON-ADRESSE.vercel.app/api/live-score
```
Tu dois voir un résultat JSON (`liveScore: null` si pas de match aujourd'hui,
ou les infos du match si le PSG joue).

## Côté app (psg-direct-app)

Dans `config.ts`, remplace la valeur par l'adresse Vercel obtenue à
l'étape 4 :
```ts
export const API_BASE_URL = "https://TON-ADRESSE.vercel.app";
```

C'est tout — tribune-sport n'a été ni touché, ni redéployé, ni redémarré.
