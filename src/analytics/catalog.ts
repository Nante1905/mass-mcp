/**
 * Tables ouvertes à `query_analytics`.
 *
 * La liste est fermée, et volontairement : une requête écrite par un modèle
 * n'a aucune raison de viser une table que personne n'a prévue. Ce qui manque
 * ici se règle en ajoutant la ligne — pas en ouvrant le contrôle.
 *
 * Elle double les droits du rôle Postgres (`sql/readonly-role.sql`), qui reste
 * la barrière qui compte : le code peut être contourné par un défaut d'analyse,
 * un `GRANT` absent ne l'est pas.
 */
export const ANALYTICS_TABLES = [
  "accounts",
  "administrators",
  "email_history",
  "email_template",
  "event_feedback",
  "event_member_registration",
  "event_public_registration",
  "event_tickets",
  "events",
  "group_member",
  "groups",
  "member_categories",
  "members",
  "membership_payements",
  "memberships",
  "payment_methods",
  "roles",
  "transactions",
  "transactions_categories",
  "type_membership",
  "users",
] as const;

/**
 * Fonctions de table admises au même titre qu'une table.
 *
 * `generate_series` sert les séries temporelles — une courbe mensuelle doit
 * pouvoir montrer les mois sans événement, ce qu'un `group by` seul ne fait
 * pas. `unnest` accompagne les agrégats.
 */
export const ANALYTICS_TABLE_FUNCTIONS = ["generate_series", "unnest"] as const;

/**
 * Colonnes que la lecture ne doit jamais rendre, quel qu'en soit le prétexte.
 *
 * Ce sont des secrets d'authentification : une empreinte de mot de passe se
 * casse hors ligne, un jeton d'invitation ouvre un compte d'administration. Ni
 * l'un ni l'autre n'a d'usage analytique, et le simple fait de les nommer dans
 * une requête suffit à la refuser — y compris dans un `where`, qui permettrait
 * de les deviner caractère par caractère.
 */
export const FORBIDDEN_COLUMNS = [
  "password",
  "confirm_token",
  "confirmation_token",
  "refresh_token",
] as const;

/**
 * Aide-mémoire du schéma, mis dans la description de `query_analytics`.
 *
 * Sans lui le modèle invente des noms de colonnes et chaque analyse coûte deux
 * ou trois allers-retours d'erreurs SQL. Il tient dans la description plutôt
 * que dans une ressource MCP parce que les adaptateurs LangGraph ne remontent
 * que les outils au modèle : une ressource ne serait jamais lue.
 */
export const SCHEMA_DIGEST = `
Tables (PostgreSQL, identifiants varchar préfixés : 'EVT..', 'MBR..', 'USR..').

events(id, title, description, location, date_event timestamp, date_closure,
  banner, is_public bool, status int, created_at, updated_at)
event_tickets(id, id_event, name, price numeric, quota int, status int)
event_member_registration(id, id_member, id_event, id_ticket, id_transaction,
  ref_payement, status int, attended int, attended_at, created_at, updated_at)
event_public_registration(id, firstname, lastname, email, phone, birth_date,
  payment_ref, id_event, id_ticket, status int, attended int, attended_at,
  created_at, updated_at)
event_feedback(id, status int, created_at, ...)
members(id, matricule, lastname, firstname, phone, birthdate date, status int,
  id_category, id_user, created_at, updated_at)
member_categories(id, ...)
memberships(id, date_membership, motivation, project_idea, domain, study_level,
  status int, id_type, id_member, updated_at)
type_membership(id, ...)
membership_payements(id, ...)
payment_methods(id, ...)
users(id, email, created_at, updated_at, id_role)   -- colonne password interdite
roles(id, code, title)
administrators(id, name, lastname, created_at, id_user)
transactions(id, ...), transactions_categories(id, ...), accounts(id, ...)

-- Listes de diffusion. Un même compte peut figurer deux fois dans un groupe :
-- compter les destinataires sans distinct les compterait en double.
groups(id, title)
group_member(id, id_group, id_user)   -- id_user référence users(id)

-- Modèles de courriel, et la trace de ce qui est parti.
email_template(id, title, subject, body)   -- corps en HTML, variables {{nom}}
email_history(id, receiver, date_email, subject, body)

Statuts (entiers, espacés de 5 ; jamais de booléen) :
  events.status              0 brouillon | 5 publié | -5 annulé
  members.status             0 inactif   | 5 actif  | -5 supprimé
  memberships.status         0 en attente| 5 validée
  membership_payements.status 0 déclaré  | 5 validé
  event_tickets.status       5 ouvert    | -5 retiré
  *_registration.status      0 existante | -5 supprimée  (cycle de vie de la ligne)
  *_registration.attended    0 inscrit   | 5 présent     (le pointage réel)
  transactions.status        5 validée   | -5 annulée

Deux registres d'inscription, jamais un seul : les membres dans
event_member_registration, les non-membres dans event_public_registration. Une
présence à un événement se compte sur les deux, réunies par UNION ALL, en
écartant status = -5 de part et d'autre.
`.trim();
