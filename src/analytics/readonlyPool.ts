import pg from "pg";

import { config } from "../config.js";

/**
 * Le pool n'existe que si la base de lecture est configurée, et il est créé au
 * premier appel : un déploiement qui n'utilise pas `query_analytics` n'ouvre
 * aucune connexion.
 */
let pool: pg.Pool | null = null;

const getPool = (): pg.Pool => {
  const database = config.analytics.database;
  if (database === null) {
    throw new Error("Base de lecture non configurée");
  }

  pool ??= new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.user,
    password: database.password,
    database: database.database,
    ssl: database.ssl ? { rejectUnauthorized: false } : false,
    // Une analyse conversationnelle est un trafic de quelques requêtes par
    // minute : trois connexions suffisent, et le plafond garantit que l'agent
    // ne peut pas priver l'API de ses propres connexions.
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
};

export const isAnalyticsConfigured = (): boolean =>
  config.analytics.database !== null;

export type AnalyticsResult = {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

/**
 * Exécute une lecture, et rien d'autre.
 *
 * Trois barrières se superposent, chacune couvrant ce que la précédente laisse
 * passer. Le rôle Postgres n'a pas le droit d'écrire — c'est la seule qui tienne
 * si le reste est contourné. La transaction `read only` refuse l'écriture même
 * si le rôle l'obtenait un jour. Le `statement_timeout` borne la durée : une
 * jointure malheureuse écrite par un modèle ne doit pas tenir la base de
 * production.
 *
 * La transaction se termine toujours par un `rollback`, jamais par un `commit` :
 * il n'y a rien à valider, et l'habitude évite qu'un ajout futur soit validé par
 * inadvertance.
 */
export const runReadOnlyQuery = async (
  sql: string,
  params: unknown[],
  maxRows: number,
): Promise<AnalyticsResult> => {
  const client = await getPool().connect();
  const startedAt = Date.now();

  try {
    await client.query("begin read only");
    // `set local` : la valeur retombe avec la transaction, elle ne reste pas
    // collée à la connexion que le pool rendra au prochain appelant.
    await client.query(
      `set local statement_timeout = ${config.analytics.timeoutMs}`,
    );
    await client.query(
      `set local idle_in_transaction_session_timeout = ${config.analytics.timeoutMs}`,
    );

    const result = await client.query({ text: sql, values: params });

    const rows = result.rows as Record<string, unknown>[];
    // Une ligne de plus que le plafond a été demandée : si elle est là, le
    // résultat est incomplet et l'appelant doit le savoir.
    const truncated = rows.length > maxRows;

    return {
      fields: result.fields.map((field) => field.name),
      rows: truncated ? rows.slice(0, maxRows) : rows,
      rowCount: truncated ? maxRows : rows.length,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // Dans un `finally` : une requête en échec laisse la transaction ouverte et
    // la connexion serait rendue au pool dans cet état, condamnant l'appel
    // suivant.
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
};

export const closeAnalyticsPool = async (): Promise<void> => {
  await pool?.end();
  pool = null;
};
