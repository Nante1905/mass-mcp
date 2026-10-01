import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Réponse d'outil, en JSON dans un bloc de texte.
 *
 * Le `structuredContent` du protocole n'est volontairement pas utilisé : il
 * suppose un `outputSchema` déclaré et tous les clients ne le rendent pas au
 * modèle. Un JSON indenté dans le contenu textuel est lu par tous, y compris
 * les adaptateurs MCP de LangGraph, et reste lisible dans l'inspecteur.
 */
export const jsonResult = (payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
});

/**
 * Échec rendu comme un résultat d'outil, et non comme une erreur de protocole.
 *
 * C'est la distinction que fait MCP : une erreur de protocole remonte au client
 * et sort de la boucle de l'agent, tandis qu'`isError` revient au modèle, qui
 * peut corriger son appel — un filtre mal formé, un identifiant qui n'existe
 * pas. Tout ce qui vient de l'appel de l'outil passe donc par ici.
 */
export const errorResult = (
  message: string,
  details?: Record<string, unknown>,
): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...details }, null, 2),
    },
  ],
});
