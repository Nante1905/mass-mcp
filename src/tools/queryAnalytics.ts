import { z } from "zod";

import { config } from "../config.js";
import { SCHEMA_DIGEST } from "../analytics/catalog.js";
import {
  isAnalyticsConfigured,
  runReadOnlyQuery,
} from "../analytics/readonlyPool.js";
import { assertReadOnlyQuery, withRowCap } from "../analytics/sqlGuard.js";
import { errorResult, jsonResult } from "../shared/result.js";
import { guarded, type ToolRegistrar } from "./shared.js";

export const registerQueryAnalytics: ToolRegistrar = (server) => {
  server.registerTool(
    "query_analytics",
    {
      title: "Requête d'analyse (lecture seule)",
      description: [
        "Exécute une requête SELECT paramétrée sur la base MASS, en lecture seule.",
        "Pour tout ce qui compte, agrège, croise ou classe : les autres outils rendent des pages,",
        "celui-ci répond sur l'ensemble des données.",
        "",
        "Règles :",
        "- une seule instruction, commençant par SELECT ou WITH ;",
        "- aucune écriture, aucun DDL, aucune fonction système (la transaction est read only) ;",
        `- ${config.analytics.maxRows} lignes rendues au plus — agréger plutôt que rapatrier ;`,
        "- les valeurs passent par `params` ($1, $2…), jamais concaténées dans le SQL.",
        "",
        SCHEMA_DIGEST,
      ].join("\n"),
      inputSchema: {
        sql: z
          .string()
          .trim()
          .min(1)
          .max(8_000)
          .describe(
            "Requête SELECT ou WITH. Les valeurs vont dans params sous forme de $1, $2…",
          ),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .default([])
          .describe(
            "Valeurs des paramètres positionnels, dans l'ordre : $1 est le premier élément",
          ),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(config.analytics.maxRows)
          .optional()
          .describe(
            `Plafond de lignes pour cet appel. Par défaut ${config.analytics.maxRows}`,
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        if (!isAnalyticsConfigured()) {
          return errorResult(
            "query_analytics est indisponible : la base de lecture n'est pas configurée sur ce déploiement (variables ANALYTICS_DB_*). Les autres outils restent utilisables.",
          );
        }

        // Le refus vient d'ici, avant toute connexion : une requête interdite
        // ne doit pas atteindre la base, et le message doit dire quoi corriger.
        assertReadOnlyQuery(args.sql);

        const maxRows = args.max_rows ?? config.analytics.maxRows;
        const result = await runReadOnlyQuery(
          withRowCap(args.sql, maxRows),
          args.params,
          maxRows,
        );

        return jsonResult({
          fields: result.fields,
          rowCount: result.rowCount,
          truncated: result.truncated,
          ...(result.truncated
            ? {
                warning: `Résultat tronqué à ${maxRows} lignes : la réponse est incomplète. Reformuler la requête en agrégat plutôt que d'augmenter le plafond.`,
              }
            : {}),
          durationMs: result.durationMs,
          rows: result.rows,
        });
      }),
  );
};
