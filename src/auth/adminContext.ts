import type { Request } from "express";

import { config } from "../config.js";
import { MassApiClient } from "../clients/massApi.js";

/**
 * Ce dont un outil dispose pour agir, le temps d'une requête MCP.
 *
 * Il n'y a rien d'autre : pas de compte de service, pas d'identité de repli.
 * Un outil ne peut donc rien faire que l'administrateur qui appelle ne puisse
 * faire lui-même depuis le back-office — le backend relit son rôle en base à
 * chaque requête, et un administrateur rétrogradé perd l'agent en même temps
 * que l'interface.
 */
export type ToolContext = {
  /** Client de l'API MASS portant le jeton de l'appelant. */
  api: MassApiClient;
};

const BEARER_PREFIX = "Bearer ";

/**
 * Jeton porté par l'entête, sans aucune vérification à ce stade.
 *
 * Le serveur MCP ne vérifie pas la signature et c'est délibéré : il n'a pas le
 * secret, et l'ajouter à sa configuration créerait un second endroit où la
 * politique d'accès se décide — donc un endroit où elle finirait par diverger.
 * C'est le backend qui tranche, comme pour le back-office.
 */
export const readBearerToken = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();

  return token.length > 0 ? token : null;
};

export const createToolContext = (token: string): ToolContext => ({
  api: new MassApiClient(
    config.massApi.baseUrl,
    token,
    config.massApi.timeoutMs,
  ),
});
