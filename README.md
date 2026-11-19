# WIN CASH — première base de la plateforme

Cette version apporte une inscription réelle, une connexion persistante par session serveur, un espace membre et une route de santé reliée à PostgreSQL.

## Variables Railway requises

Ajouter au service web :
- `DATABASE_URL` : variable fournie par le service PostgreSQL Railway (référencer la variable du service PostgreSQL).
- `SESSION_SECRET` : secret aléatoire long d'au moins 32 caractères.
- `NODE_ENV=production`

Le serveur crée les tables `users` et `user_sessions` au démarrage.

## Déploiement

1. Ajouter ces fichiers à la branche `feature/wincash-backend-foundation`.
2. Dans Railway, relier le service web au service PostgreSQL.
3. Vérifier que le service web utilise cette branche et exécute `npm start`.
4. Consulter `/api/health` : le résultat doit indiquer `database: connected`.
5. Tester une inscription, fermer la page, puis revenir et se reconnecter.

## Administration

Les nouveaux comptes ont le rôle `user` par défaut. Ne pas rendre un utilisateur administrateur depuis le navigateur. Après déploiement, attribuer le rôle admin directement en base, depuis un accès administrateur sécurisé, avec une adresse vérifiée :

```sql
UPDATE users SET role = 'admin' WHERE email = 'adresse-admin-verifiee@example.com';
```

Remplacer l'adresse par celle du propriétaire du compte.

## Limites et sécurité

- Aucun dépôt, retrait, solde monétaire, paiement ou pari en argent réel n'est implémenté.
- Les mots de passe sont dérivés avec `scrypt` et un sel aléatoire.
- Les sessions sont stockées dans PostgreSQL et le cookie est `HttpOnly`, `SameSite=Lax`, `Secure` en production.
- L'application doit être testée, faire l'objet d'une revue de sécurité et être complétée par la vérification d'e-mail, la récupération de mot de passe, la protection CSRF adaptée au déploiement et les règles de confidentialité avant ouverture publique.
- Ne jamais publier `SESSION_SECRET`, un mot de passe ou une URL de base de données contenant des identifiants.
