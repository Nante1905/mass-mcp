import { z } from "zod";

import { jsonResult } from "../shared/result.js";
import {
  TRANSACTION_STATUS_BY_NAME,
  TRANSACTION_TYPE_BY_NAME,
  guarded,
  isoDate,
  type ToolRegistrar,
} from "./shared.js";

type TransactionStats = {
  credit: { count: number; total: number };
  debit: { count: number; total: number };
  netFlow: number;
  count: number;
};

type Referential = { id: string; code?: string; title?: string; name?: string };

export const registerGetFinanceSummary: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "get_finance_summary",
    {
      title: "Synthèse financière",
      description: [
        "Totaux du journal comptable sur une période : entrées, sorties, flux net, nombre d'écritures.",
        "Seules les écritures validées comptent par défaut — une écriture annulée est sortie du solde.",
        "Les montants sont toujours positifs des deux côtés : c'est le sens (credit / debit) qui porte la direction.",
        "Les listes de comptes et de catégories peuvent être jointes pour retrouver un identifiant de filtre.",
      ].join(" "),
      inputSchema: {
        date_from: isoDate
          .optional()
          .describe("Borne de début, incluse, sur la date de l'opération"),
        date_to: isoDate
          .optional()
          .describe("Borne de fin, incluse, sur la date de l'opération"),
        type: z
          .enum(["credit", "debit"])
          .optional()
          .describe("Sens des écritures retenues. Sans filtre, les deux"),
        status: z
          .enum(["validated", "cancelled"])
          .default("validated")
          .describe(
            "'cancelled' donne le volume annulé sur la période, ce qui se regarde parfois pour lui-même",
          ),
        account_id: z.string().trim().min(1).max(50).optional(),
        category_id: z.string().trim().min(1).max(50).optional(),
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Recherche libre sur la description et la référence"),
        include_referentials: z
          .boolean()
          .default(false)
          .describe(
            "Joindre la liste des comptes et des catégories, pour retrouver un identifiant à filtrer",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const query = {
          dateFrom: args.date_from,
          dateTo: args.date_to,
          type:
            args.type === undefined
              ? undefined
              : TRANSACTION_TYPE_BY_NAME[args.type],
          status: TRANSACTION_STATUS_BY_NAME[args.status],
          idAccount: args.account_id,
          idTrxCategory: args.category_id,
          search: args.search,
        };

        const stats = await api.get<TransactionStats>(
          "/transactions/stats",
          query,
        );

        const summary = {
          period: { from: args.date_from ?? null, to: args.date_to ?? null },
          status: args.status,
          credit: stats.credit,
          debit: stats.debit,
          netFlow: stats.netFlow,
          count: stats.count,
        };

        if (!args.include_referentials) {
          return jsonResult(summary);
        }

        // Les deux référentiels sont lus en parallèle : ils ne dépendent pas
        // l'un de l'autre, et les enchaîner doublerait l'attente pour rien.
        const [accounts, categories] = await Promise.all([
          api.get<Referential[]>("/transactions/accounts"),
          api.get<Referential[]>("/transactions/categories"),
        ]);

        return jsonResult({ ...summary, accounts, categories });
      }),
  );
};
