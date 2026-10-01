import { z } from "zod";

import { jsonResult } from "../shared/result.js";
import { guarded, type ToolRegistrar } from "./shared.js";

type CreateEmailTemplateResult = {
  templateId: string;
  title: string | null;
  subject: string;
};

/** Variables `{{nom}}` citées par un texte, dans l'ordre, sans doublon. */
const declaredVariables = (...texts: string[]): string[] => [
  ...new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(
        (match) => match[1]!,
      ),
    ),
  ),
];

export const registerCreateEmailTemplate: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "create_email_template",
    {
      title: "Créer un modèle de courriel",
      description: [
        "Enregistre un modèle de courriel réutilisable : objet, corps, et ses variables.",
        "",
        "N'envoie rien. Un modèle est un texte rangé, que le back-office rouvrira — c'est",
        "send_email qui écrit à quelqu'un, et lui seul.",
        "",
        "Les variables s'écrivent {{prenom}}, {{nom}}, {{titre_evenement}} : le même moteur",
        "que les gabarits de l'application. Rien n'est vérifié à l'enregistrement — une variable",
        "n'a de sens qu'au moment du rendu, et c'est l'appelant qui fournira sa valeur.",
        "",
        "Le corps part en HTML : les sauts de ligne doivent être des balises, une chaîne",
        "avec des retours chariot s'affichera d'un seul bloc.",
      ].join("\n"),
      inputSchema: {
        subject: z
          .string()
          .trim()
          .min(1)
          .max(250)
          .describe("Objet du courriel. Peut lui aussi porter des variables"),
        body: z
          .string()
          .trim()
          .min(1)
          .describe("Corps du message, en HTML"),
        title: z
          .string()
          .trim()
          .min(1)
          .max(150)
          .optional()
          .describe(
            "Nom du modèle au back-office. Omis, seul l'objet permettra de le reconnaître — et l'objet change d'une version à l'autre",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const created = await api.post<CreateEmailTemplateResult>(
          "/communication/templates",
          {
            subject: args.subject,
            body: args.body,
            ...(args.title === undefined ? {} : { title: args.title }),
          },
        );

        return jsonResult({
          templateId: created.templateId,
          title: created.title,
          subject: created.subject,
          // Rendues à l'appelant plutôt que laissées à deviner : c'est la
          // liste exacte de ce qu'il faudra fournir au rendu, et une coquille
          // dans un nom de variable se voit ici.
          variables: declaredVariables(args.subject, args.body),
          message:
            "Modèle enregistré. Aucun courriel n'a été envoyé : le modèle est réutilisable avec send_email.",
        });
      }),
  );
};
