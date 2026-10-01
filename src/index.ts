import { closeAnalyticsPool } from "./analytics/readonlyPool.js";
import { config } from "./config.js";
import { createHttpServer } from "./http/server.js";

const app = createHttpServer();

const server = app.listen(config.http.port, config.http.host, () => {
  console.log(
    `Serveur MCP MASS à l'écoute sur http://${config.http.host}:${config.http.port}/mcp`,
  );
  console.log(`  API MASS      : ${config.massApi.baseUrl}`);
  console.log(
    `  query_analytics : ${
      config.analytics.database === null
        ? "désactivé (ANALYTICS_DB_* non renseignées)"
        : `${config.analytics.database.host}:${config.analytics.database.port}/${config.analytics.database.database} en tant que ${config.analytics.database.user}`
    }`,
  );
  if (config.http.allowedOrigins.length === 0) {
    console.warn(
      "  Attention : MCP_ALLOWED_ORIGINS est vide, la protection contre le DNS rebinding est désactivée.",
    );
  }
});

/**
 * Arrêt propre : le pool de lecture garde des connexions ouvertes côté
 * Postgres, et un conteneur remplacé sans les fermer les y laisse jusqu'à
 * expiration.
 */
const shutdown = (signal: string): void => {
  console.log(`\n${signal} reçu, arrêt en cours.`);
  server.close(() => {
    void closeAnalyticsPool().finally(() => process.exit(0));
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
