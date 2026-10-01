import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../auth/adminContext.js";
import { MassApiError } from "../clients/massApi.js";
import { SqlGuardError } from "../analytics/sqlGuard.js";
import { errorResult } from "../shared/result.js";

/**
 * Un outil s'enregistre auprès du serveur en recevant le contexte de l'appelant.
 *
 * Le contexte est passé à l'enregistrement et non à l'appel : en mode sans
 * session, un serveur est construit par requête HTTP, et le jeton qu'il porte
 * ne vaut que pour celle-là.
 */
export type ToolRegistrar = (server: McpServer, context: ToolContext) => void;

/**
 * Traduit en résultat d'outil ce qui a échoué pendant l'appel.
 *
 * Les erreurs d'authentification sont distinguées des autres : ce sont les
 * seules que l'agent ne peut pas corriger en reformulant. Le lui dire
 * explicitement évite qu'il rejoue le même appel en boucle en croyant à une
 * erreur de paramètre.
 */
export const toToolError = (error: unknown): CallToolResult => {
  if (error instanceof MassApiError) {
    if (error.status === 401 || error.status === 403) {
      return errorResult(
        "Accès refusé par l'API MASS : le jeton d'administrateur est expiré, invalide, ou le compte n'a plus le rôle administrateur. Inutile de réessayer : la session doit être renouvelée depuis le back-office.",
        { status: error.status, apiMessage: error.message },
      );
    }

    return errorResult(error.message, {
      status: error.status,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    });
  }

  if (error instanceof SqlGuardError) {
    return errorResult(error.message, { rejectedBy: "sql_guard" });
  }

  return errorResult(
    error instanceof Error ? error.message : "Erreur inattendue",
  );
};

/** Enveloppe commune : aucun outil ne doit laisser fuiter une exception. */
export const guarded = async (
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> => {
  try {
    return await run();
  } catch (error) {
    return toToolError(error);
  }
};

/**
 * Statuts d'événement, nommés.
 *
 * Le backend les manipule en entiers espacés de 5. Les exposer tels quels
 * obligerait le modèle à retenir que `-5` est « annulé » et `0` « brouillon »,
 * ce qu'il se trompera régulièrement à faire. La traduction se fait ici, une
 * fois.
 */
export const EVENT_STATUS_BY_NAME = {
  draft: 0,
  published: 5,
  cancelled: -5,
} as const;

export const eventStatusName = (value: number): string =>
  Object.entries(EVENT_STATUS_BY_NAME).find(
    ([, code]) => code === value,
  )?.[0] ?? `inconnu(${value})`;

/** Statuts de membre, nommés — même raison que ci-dessus. */
export const MEMBER_STATUS_BY_NAME = {
  inactive: 0,
  active: 5,
  deleted: -5,
} as const;

export const memberStatusName = (value: number | null): string =>
  value === null
    ? "inconnu"
    : (Object.entries(MEMBER_STATUS_BY_NAME).find(
        ([, code]) => code === value,
      )?.[0] ?? `inconnu(${value})`);

/** Statuts d'une adhésion, nommés. */
export const MEMBERSHIP_STATUS_BY_NAME = {
  pending: 0,
  validated: 5,
} as const;

export const membershipStatusName = (value: number | null): string =>
  value === null
    ? "inconnu"
    : (Object.entries(MEMBERSHIP_STATUS_BY_NAME).find(
        ([, code]) => code === value,
      )?.[0] ?? `inconnu(${value})`);

/**
 * Statuts d'un paiement d'adhésion, nommés.
 *
 * `pending` ne veut pas dire « impayé » : le paiement est déclaré par le
 * demandeur, il n'est simplement pas encore rapproché d'une écriture comptable.
 */
export const PAYMENT_STATUS_BY_NAME = {
  pending: 0,
  validated: 5,
} as const;

export const paymentStatusName = (value: number | null): string =>
  value === null
    ? "inconnu"
    : (Object.entries(PAYMENT_STATUS_BY_NAME).find(
        ([, code]) => code === value,
      )?.[0] ?? `inconnu(${value})`);

/** Pointage d'une inscription, nommé. */
export const ATTENDANCE_BY_NAME = {
  registered: 0,
  present: 5,
} as const;

/**
 * Ligne d'inscription supprimée, dans les deux registres.
 *
 * À ne pas confondre avec le pointage : ce statut ne dit que si la ligne existe
 * encore. Une inscription supprimée a rendu sa place, et n'entre donc dans
 * aucun dénominateur de présence.
 */
export const EVENT_REGISTRATION_DELETED = -5;

export const attendanceName = (value: number): string =>
  value === ATTENDANCE_BY_NAME.present ? "present" : "registered";

/** Sens d'une écriture comptable, nommé. */
export const TRANSACTION_TYPE_BY_NAME = {
  credit: 5,
  debit: -5,
} as const;

/** Statut d'une écriture comptable, nommé. */
export const TRANSACTION_STATUS_BY_NAME = {
  validated: 5,
  cancelled: -5,
} as const;

/**
 * Date au format ISO, contrôlée ici plutôt que par le backend.
 *
 * Un modèle écrit volontiers « 15 mars 2026 » : le refus doit nommer le format
 * attendu, ce qu'un 400 générique du backend ne ferait pas.
 */
export const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Date invalide : format ISO 8601 attendu (2026-03-15T18:00:00Z)",
  });

/**
 * Pagination commune aux listes de l'API.
 *
 * Pas de `z.coerce` ici, contrairement aux schémas du backend : ceux-ci lisent
 * une chaîne de requête où tout est texte, tandis qu'un appel MCP arrive en
 * JSON typé. Coercer masquerait un modèle qui envoie `"vingt"`.
 */
export const paginationShape = {
  page: z.number().int().min(1).default(1).describe("Page, à partir de 1"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Lignes par page, 100 au plus"),
};
