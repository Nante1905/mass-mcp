import { z } from "zod";

import {
  isAnalyticsConfigured,
  runReadOnlyQuery,
} from "../analytics/readonlyPool.js";
import { errorResult, jsonResult } from "../shared/result.js";
import { guarded, type ToolRegistrar } from "./shared.js";

type SendEmailResult = {
  historyId: string;
  receiver: string;
  subject: string;
};

type SendGroupedEmailResult = {
  groupId: string;
  sent: string[];
  failed: string[];
};

/**
 * Composition d'une liste de diffusion, pour l'aperçu.
 *
 * Les jointures sont ouvertes des deux côtés, à la différence de celle du
 * backend qui envoie : ici il faut distinguer un groupe qui n'existe pas
 * — aucune ligne — d'un groupe vide, qui en rend une sans adresse. Confondre
 * les deux ferait annoncer « aucun destinataire » pour un identifiant inventé.
 *
 * `distinct` parce que rien n'interdit d'inscrire deux fois le même compte : le
 * backend l'écarte à l'envoi, l'aperçu doit compter comme lui.
 */
const GROUP_RECIPIENTS_QUERY = `
  select distinct g.title as group_title, u.email as email
  from "groups" g
  left join group_member gm on gm.id_group = g.id
  left join users u on u.id = gm.id_user
  where g.id = $1
  order by u.email nulls last
  limit $2
`;

/** Au-delà, l'aperçu cite un échantillon : une liste de 500 adresses ne se relit pas. */
const PREVIEW_RECIPIENTS_SHOWN = 50;
/** Un groupe est plafonné à 500 comptes à sa création : au-delà, il n'y a rien. */
const GROUP_MAX_RECIPIENTS = 500;

export const registerSendEmail: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "send_email",
    {
      title: "Envoyer un courriel",
      description: [
        "Écrit à une adresse, ou à tous les comptes d'une liste de diffusion.",
        "",
        "Envoi soumis à validation humaine. Appelé sans `confirmed: true`, l'outil n'envoie rien :",
        "il rend l'aperçu — destinataires résolus, objet, corps intégral — à faire relire avant",
        "de rappeler le même appel avec `confirmed: true`.",
        "",
        "Un courriel envoyé ne se rappelle pas. C'est la seule écriture de ce serveur qui sorte",
        "de l'association : elle part de la boîte de l'association et engage son nom.",
        "",
        "Le corps est interprété en HTML — les retours à la ligne doivent être des balises.",
        "Chaque envoi est tracé dans l'historique des courriels.",
        "",
        "Pour partir d'un modèle enregistré, le relire d'abord avec query_analytics sur",
        "`email_template`, y substituer les {{variables}}, puis passer le résultat ici.",
      ].join("\n"),
      inputSchema: {
        to: z
          .email()
          .trim()
          .max(150)
          .optional()
          .describe(
            "Adresse du destinataire, pour un envoi unique. Exclusif de group_id",
          ),
        group_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Liste de diffusion à servir. Les identifiants de groupe se retrouvent avec query_analytics sur la table `groups`. Exclusif de to",
          ),
        subject: z.string().trim().min(1).max(250),
        body: z.string().trim().min(1).describe("Corps du message, en HTML"),
        confirmed: z
          .boolean()
          .default(false)
          .describe(
            "Doit valoir true pour que le courriel parte. À ne poser qu'après validation explicite d'un humain, jamais de sa propre initiative",
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Un envoi ne détruit rien, mais il ne se défait pas non plus : le
        // rejouer écrit une seconde fois au destinataire.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      guarded(async () => {
        const hasSingle = args.to !== undefined;
        const hasGroup = args.group_id !== undefined;

        if (hasSingle === hasGroup) {
          return errorResult(
            hasSingle
              ? "Renseigner `to` ou `group_id`, pas les deux : un envoi vise une adresse ou une liste, jamais les deux à la fois."
              : "Aucun destinataire : renseigner `to` pour une adresse, ou `group_id` pour une liste de diffusion.",
          );
        }

        if (args.confirmed) {
          if (args.to !== undefined) {
            const result = await api.post<SendEmailResult>(
              "/communication/emails",
              {
                receiver: args.to,
                subject: args.subject,
                body: args.body,
              },
            );

            return jsonResult({
              sent: true,
              receiver: result.receiver,
              subject: result.subject,
              historyId: result.historyId,
              message: "Courriel remis et tracé dans l'historique.",
            });
          }

          const result = await api.post<SendGroupedEmailResult>(
            `/communication/groups/${encodeURIComponent(args.group_id!)}/emails`,
            { subject: args.subject, body: args.body },
          );

          return jsonResult({
            sent: true,
            groupId: result.groupId,
            sentTo: result.sent,
            failed: result.failed,
            message:
              result.failed.length > 0
                ? `${result.sent.length} envoi(s) remis, ${result.failed.length} en échec. Les adresses en échec sont à reprendre une par une.`
                : `${result.sent.length} envoi(s) remis et tracés dans l'historique.`,
          });
        }

        // Aucun envoi au-delà de ce point : on décrit ce qui partirait.
        const preview = {
          sent: false,
          confirmationRequired: true,
          subject: args.subject,
          // Le corps intégral, et non un extrait : c'est ce que le relecteur
          // doit lire avant d'engager le nom de l'association.
          body: args.body,
          bodyIsHtml: true,
          nextStep:
            "Présenter les destinataires, l'objet et le corps à l'utilisateur. S'il approuve, rappeler send_email avec les mêmes paramètres et confirmed: true.",
        };

        if (args.to !== undefined) {
          return jsonResult({
            ...preview,
            mode: "single",
            recipients: [args.to],
            recipientCount: 1,
          });
        }

        // Une liste dont on ne peut pas lire la composition ne se valide pas :
        // l'humain approuverait un identifiant, pas des destinataires. Sans base
        // de lecture, l'envoi groupé est donc refusé plutôt que fait à l'aveugle.
        if (!isAnalyticsConfigured()) {
          return errorResult(
            "Envoi groupé impossible : la base de lecture n'est pas configurée (variables ANALYTICS_DB_*), la composition du groupe ne peut pas être vérifiée. Envoyer aux adresses une par une avec `to`.",
          );
        }

        const resolved = await runReadOnlyQuery(
          GROUP_RECIPIENTS_QUERY,
          [args.group_id, GROUP_MAX_RECIPIENTS + 1],
          GROUP_MAX_RECIPIENTS,
        );

        if (resolved.rows.length === 0) {
          return errorResult(
            `Aucun groupe ne porte l'identifiant ${args.group_id}. Retrouver les listes de diffusion avec query_analytics sur la table \`groups\`.`,
          );
        }

        const groupTitle = (resolved.rows[0]?.["group_title"] ?? null) as
          | string
          | null;
        const recipients = resolved.rows
          .map((row) => row["email"])
          .filter((email): email is string => typeof email === "string");

        if (recipients.length === 0) {
          return errorResult(
            `Le groupe ${args.group_id}${groupTitle === null ? "" : ` (${groupTitle})`} ne compte aucun compte avec une adresse : il n'y a personne à qui écrire.`,
          );
        }

        return jsonResult({
          ...preview,
          mode: "group",
          groupId: args.group_id,
          groupTitle,
          recipientCount: recipients.length,
          recipients: recipients.slice(0, PREVIEW_RECIPIENTS_SHOWN),
          ...(recipients.length > PREVIEW_RECIPIENTS_SHOWN
            ? {
                recipientsNote: `${PREVIEW_RECIPIENTS_SHOWN} adresses citées sur ${recipients.length} : l'envoi couvrira les ${recipients.length}.`,
              }
            : {}),
        });
      }),
  );
};
