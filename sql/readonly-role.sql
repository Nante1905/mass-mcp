-- Rôle Postgres de `query_analytics`.
--
-- À jouer une fois sur la base MASS, avec un rôle qui en est propriétaire :
--
--   psql -h localhost -p 5432 -U postgres -d mass -f sql/readonly-role.sql
--
-- C'est la barrière qui compte. Les contrôles de `src/analytics/sqlGuard.ts`
-- rendent les refus lisibles et arrêtent une requête avant la base, mais ils
-- analysent du texte : un jour ou l'autre, une tournure leur échappera. Un
-- `GRANT` absent, lui, n'a pas de faille d'analyse.
--
-- Le mot de passe est à remplacer avant exécution, puis à reporter dans
-- `ANALYTICS_DB_PASSWORD`.

create role mass_readonly with login password 'à-remplacer' nosuperuser nocreatedb nocreaterole noinherit;

-- Se connecter et voir le schéma, rien de plus à ce stade.
grant connect on database mass to mass_readonly;
grant usage on schema public to mass_readonly;

-- Lecture sur les tables ouvertes à l'analyse. La liste est la même que celle
-- d'`ANALYTICS_TABLES` dans `src/analytics/catalog.ts` : les deux se tiennent,
-- et ajouter une table demande de le faire des deux côtés.
grant select on
  accounts,
  administrators,
  email_history,
  email_template,
  event_feedback,
  event_member_registration,
  event_public_registration,
  event_tickets,
  events,
  group_member,
  groups,
  member_categories,
  members,
  membership_payements,
  memberships,
  payment_methods,
  roles,
  transactions,
  transactions_categories,
  type_membership
to mass_readonly;

-- `users` colonne par colonne : `password` porte l'empreinte du mot de passe.
-- Un `grant select` sur la table entière l'exposerait, et une empreinte se
-- casse hors ligne — la lire est aussi grave que lire le mot de passe.
grant select (id, email, created_at, updated_at, id_role, status) on users to mass_readonly;

-- Aucun droit par défaut sur ce qui sera créé plus tard : une table ajoutée par
-- une migration n'est pas lisible tant que la ligne n'a pas été ajoutée
-- ci-dessus, et c'est le comportement voulu.
alter default privileges in schema public revoke all on tables from mass_readonly;

-- Vérification : cette requête doit rendre 0 ligne.
--
--   select table_name, privilege_type
--   from information_schema.table_privileges
--   where grantee = 'mass_readonly' and privilege_type <> 'SELECT';
