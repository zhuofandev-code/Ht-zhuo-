# ZHUO FAN HT — nouveau backend

API Node.js + Express + PostgreSQL, prévue pour Render et le frontend HTML existant.

## Déploiement depuis le téléphone

1. Crée une base **PostgreSQL** dans Render. Copie son **Internal Database URL** si le service est aussi sur Render.
2. Mets ces fichiers dans un dépôt GitHub (racine du dépôt, pas dans un sous-dossier).
3. Render → New → Web Service → connecte le dépôt.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Ajoute les variables dans Render → Environment:
   - `DATABASE_URL` = URL PostgreSQL complète
   - `JWT_SECRET` = longue chaîne aléatoire, différente du mot de passe admin
   - `ADMIN_EMAIL` = ton e-mail administrateur
   - `ADMIN_PASSWORD` = mot de passe administrateur fort
   - `ADMIN_NAME` = Zhuo Fan (facultatif)
   - `FRONTEND_ORIGIN` = URL exacte de ton site frontend, par ex. `https://mon-site.vercel.app`; plusieurs origines séparées par des virgules. Pour les tests seulement, `*` accepte toutes les origines.
7. Deploy. Ouvre `https://TON-SERVICE.onrender.com/healthz`; il doit afficher `ok: true` et `database: connected`.

## API fournie

- Inscription / connexion e-mail et mot de passe, JWT, rôles user/admin
- `/api/me`, `/api/wallet`
- Dépôts MonCash/NatCash: création, historique, validation admin qui crédite le wallet une seule fois
- Commandes: historique, achat avec contrôle du solde et débit atomique
- Administration: aperçu, demandes de dépôts, commandes, gestion des packs/prix, crédit manuel du wallet
- Paramètres guide / chaîne (`/api/guide`, `PUT /api/admin/guide`)
- Endpoint spin sécurisé de base (`POST /api/spin`); les probabilités/récompenses ne sont **pas** configurées ici et doivent être définies avant d'activer des gains réels.

## Important pour le HTML fourni

Le fichier HTML actuel appelle déjà:
- `POST /api/auth/register` avec `email` et `password`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/guide`
- `PUT /api/admin/guide`

L'inscription accepte `name`, `fullName` ou `pseudo` en plus de l'e-mail/mot de passe. Pour que le formulaire actuel transmette le nom, son JavaScript doit envoyer `{name: ..., email: ..., password: ...}`; le backend refuse les inscriptions sans nom complet.

Le frontend actuel stocke beaucoup de commandes, prix et fonctions spin dans son propre `localStorage`. Ce backend expose des endpoints sécurisés pour ces fonctionnalités, mais le HTML doit être raccordé à ces endpoints pour que les données deviennent partagées entre les téléphones. Il ne peut pas modifier le HTML tout seul.

## Sécurité / limites
- Ne mets jamais `ADMIN_PASSWORD`, `JWT_SECRET` ou `DATABASE_URL` dans le HTML ni dans GitHub.
- Ce backend ne traite pas automatiquement les paiements MonCash/NatCash; il crée des demandes que l'administrateur approuve manuellement.
- L'upload vidéo binaire n'est pas inclus: Render peut effacer les fichiers locaux au redémarrage. Le guide utilise des URL; utiliser un stockage d'objets externe pour les vidéos.
