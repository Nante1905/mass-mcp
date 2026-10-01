import {
  ANALYTICS_TABLE_FUNCTIONS,
  ANALYTICS_TABLES,
  FORBIDDEN_COLUMNS,
} from "./catalog.js";

/** Refus motivé d'une requête d'analyse, avant tout contact avec la base. */
export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

/**
 * Mots-clés qui n'ont rien à faire dans une lecture.
 *
 * Les trois premiers groupes écrivent ou modifient le schéma ; les suivants
 * sortent du périmètre de la base — lire un fichier du serveur, joindre une
 * autre base, tuer une session, endormir la connexion. La transaction en
 * lecture seule bloque déjà les écritures : cette liste est là pour que le refus
 * soit lisible plutôt que rendu par une erreur Postgres, et pour couvrir ce
 * qu'une transaction en lecture seule laisse passer — `pg_sleep` et
 * `pg_read_file` en sont.
 */
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "copy",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "refresh",
  "call",
  "do",
  "set",
  "reset",
  "listen",
  "notify",
  "unlisten",
  "lock",
  "prepare",
  "deallocate",
  "declare",
  "fetch",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "into",
  "dblink",
  "pg_sleep",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "lo_import",
  "lo_export",
  "current_setting",
  "set_config",
] as const;

const READ_ONLY_PREFIX = /^\s*(?:select|with)\b/i;

/**
 * Requête débarrassée de ce qui pourrait cacher un mot-clé.
 *
 * Sans cette passe, `select 'drop table'` serait refusé et
 * `select 1 /* ; delete from members *\/` accepté : c'est la même méprise dans
 * les deux sens. Les littéraux deviennent des jetons neutres et non du vide,
 * pour ne pas souder deux identifiants voisins en un seul.
 *
 * Le dollar-quoting passe en premier : son contenu peut légitimement contenir
 * des apostrophes, et le traiter après les aurait laissées désapparier.
 *
 * Les guillemets doubles ne délimitent pas une chaîne mais un identifiant, dont
 * le contenu est un nom et jamais du code. Un nom simple est donc rendu tel
 * quel, sans quoi `from "groups"` — la seule façon d'écrire une table dont le
 * nom est un mot-clé — serait refusée pour table inconnue. Un nom qui ne
 * ressemble pas à un identifiant devient un jeton neutre : rien de réel ne
 * s'appelle ainsi, et le refus qui suivra est le bon comportement.
 */
const stripNoise = (sql: string): string =>
  sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ' ' ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ' ' ")
    .replace(/"((?:[^"]|"")*)"/g, (_match: string, inner: string) =>
      /^[A-Za-z_][A-Za-z0-9_$]*$/.test(inner) ? ` ${inner} ` : " quoted_ident ",
    );

/**
 * Noms donnés aux tables temporaires d'un `with`.
 *
 * Ils apparaîtront après un `from` comme n'importe quelle table : sans les
 * recenser, toute requête à CTE serait refusée pour table inconnue.
 */
const cteNames = (stripped: string): Set<string> => {
  const names = new Set<string>();
  const pattern =
    /(?:\bwith\b|,)\s*(?:recursive\s+)?([a-z_]\w*)\s*(?:\([^)]*\)\s*)?as\s*(?:(?:not\s+)?materialized\s*)?\(/gi;

  for (const match of stripped.matchAll(pattern)) {
    const name = match[1];
    if (name) {
      names.add(name.toLowerCase());
    }
  }

  return names;
};

/** Tables et fonctions de table citées après un `from` ou un `join`. */
const referencedRelations = (
  stripped: string,
): { schema: string | null; relation: string }[] => {
  const pattern =
    /\b(?:from|join)\s+(?:only\s+)?([a-z_][\w$]*)(?:\s*\.\s*([a-z_][\w$]*))?/gi;

  return [...stripped.matchAll(pattern)].map((match) => {
    const first = match[1]!.toLowerCase();
    const second = match[2]?.toLowerCase();

    return second === undefined
      ? { schema: null, relation: first }
      : { schema: first, relation: second };
  });
};

const ALLOWED_RELATIONS = new Set<string>([
  ...ANALYTICS_TABLES,
  ...ANALYTICS_TABLE_FUNCTIONS,
]);

/**
 * Refuse tout ce qui n'est pas une lecture du périmètre MASS.
 *
 * Rien de ce qui suit n'est la sécurité : la sécurité, c'est le rôle Postgres
 * sans droit d'écriture et la transaction `read only`. Ces contrôles sont là
 * pour que le refus arrive avant la base, avec une phrase qui dit quoi
 * corriger — un modèle qui reçoit « permission denied for table users » repart
 * sur une autre formulation du même geste interdit, alors qu'il comprend
 * « la table X n'est pas ouverte à l'analyse ».
 */
export const assertReadOnlyQuery = (sql: string): void => {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new SqlGuardError("Requête vide");
  }

  const stripped = stripNoise(trimmed);

  if (!READ_ONLY_PREFIX.test(stripped)) {
    throw new SqlGuardError(
      "Seules les requêtes de lecture sont acceptées : la requête doit commencer par SELECT ou WITH",
    );
  }

  // Le point-virgule final est toléré — on l'écrit par habitude. Un second
  // ordre ne l'est pas : c'est par là que passerait une écriture accrochée à
  // une lecture d'apparence anodine.
  if (stripped.replace(/;\s*$/, "").includes(";")) {
    throw new SqlGuardError(
      "Une seule instruction par appel : le point-virgule ne peut apparaître qu'en fin de requête",
    );
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(stripped)) {
      throw new SqlGuardError(
        `Mot-clé interdit dans une requête d'analyse : ${keyword.toUpperCase()}`,
      );
    }
  }

  for (const column of FORBIDDEN_COLUMNS) {
    if (new RegExp(`\\b${column}\\b`, "i").test(stripped)) {
      throw new SqlGuardError(
        `Colonne interdite : ${column}. Les secrets d'authentification ne sont lisibles par aucun outil.`,
      );
    }
  }

  const temporaries = cteNames(stripped);
  for (const { schema, relation } of referencedRelations(stripped)) {
    if (schema !== null && schema !== "public") {
      throw new SqlGuardError(
        `Schéma interdit : ${schema}. Seul le schéma public est ouvert à l'analyse.`,
      );
    }

    if (!ALLOWED_RELATIONS.has(relation) && !temporaries.has(relation)) {
      throw new SqlGuardError(
        `Table inconnue ou fermée à l'analyse : ${relation}. Tables ouvertes : ${ANALYTICS_TABLES.join(", ")}.`,
      );
    }
  }
};

/**
 * Requête encapsulée pour plafonner le nombre de lignes rendues.
 *
 * Le `limit` est posé à l'extérieur plutôt qu'ajouté à la requête : celle-ci
 * peut déjà en porter un, et deux `limit` côte à côte ne se composent pas.
 * Encapsulée, la requête garde le sien — le plafond ne fait que le borner.
 *
 * Une ligne de plus que le plafond est demandée : c'est ce qui permet de dire
 * à l'appelant que le résultat a été tronqué plutôt que de le laisser conclure
 * qu'il tient le compte exact.
 */
export const withRowCap = (sql: string, maxRows: number): string =>
  `select * from (${sql.trim().replace(/;\s*$/, "")}) as mcp_analytics limit ${maxRows + 1}`;
