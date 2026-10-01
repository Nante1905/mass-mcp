import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ToolContext } from "../auth/adminContext.js";
import { TOOL_REGISTRARS } from "../tools/index.js";

/**
 * Serveur MCP construit pour un appelant, et pour lui seul.
 *
 * Le transport est sans session : une instance par requête HTTP, jetée avec
 * elle. C'est ce qui rend la propagation du jeton sûre — un serveur partagé
 * devrait faire porter l'identité par l'appel, et il suffirait d'un outil
 * distrait pour qu'il se serve du jeton du voisin. Ici, l'outil n'a accès qu'au
 * client construit avec le jeton de sa propre requête.
 *
 * Le coût est un objet à créer par requête. Sur un trafic de back-office
 * conversationnel — quelques appels par minute — il ne se mesure pas.
 */
export const createMcpServer = (context: ToolContext): McpServer => {
  const server = new McpServer(
    {
      name: "mass-mcp",
      version: "0.1.0",
    },
    {
      instructions: [
        "Outils du back-office MASS (association d'astronomie).",
        "",
        "Lectures : list_events, get_event_details, list_members, get_member_details et",
        "get_finance_summary répondent sur un objet précis. get_attendance_stats agrège les",
        "présences par évènement, par membre ou par mois. Toute autre question qui compte,",
        "croise ou classe passe par query_analytics, qui voit l'ensemble des données.",
        "",
        "Écritures : create_event_draft ne crée que des brouillons — cet outil ne publie pas.",
        "update_draft ne touche qu'aux brouillons. create_email_template range un texte et",
        "n'envoie rien.",
        "",
        "Deux outils écrivent en engageant quelqu'un et n'agissent qu'en deux temps :",
        "mark_attendance, qui pointe des présences et déclenche l'envoi des liens d'avis, et",
        "send_email, qui écrit au nom de l'association. Tous deux rendent d'abord un aperçu",
        "et n'exécutent qu'au second appel.",
        "",
        "Ne jamais poser `confirmed: true` de sa propre initiative : ce champ atteste qu'une",
        "personne a relu et approuvé, pas que l'action semble raisonnable. Un courriel envoyé",
        "ne se rappelle pas.",
        "",
        "Les données de membres sont personnelles : les rapporter pour répondre à la question",
        "posée, jamais en annexe « pour information ».",
      ].join("\n"),
    },
  );

  for (const register of TOOL_REGISTRARS) {
    register(server, context);
  }

  return server;
};
