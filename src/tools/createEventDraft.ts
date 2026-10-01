import { z } from "zod";

import { errorResult, jsonResult } from "../shared/result.js";
import {
  EVENT_STATUS_BY_NAME,
  guarded,
  isoDate,
  type ToolRegistrar,
} from "./shared.js";

type CreateEventResult = { eventId: string; ticketIds: string[] };

/**
 * Tarif proposé à l'inscription.
 *
 * Le nom n'est pas un libellé : c'est lui qui décide du registre où atterrit
 * l'inscription — `member` exige une adhésion à jour, `public` est ouvert à
 * tous. D'où la liste fermée, et d'où le fait qu'un évènement ne puisse pas
 * porter deux tarifs du même nom.
 */
const ticketSchema = z.object({
  audience: z
    .enum(["member", "public"])
    .describe(
      "'member' : réservé aux membres à jour de cotisation. 'public' : ouvert à tous",
    ),
  price: z
    .number()
    .nonnegative()
    .multipleOf(0.01)
    .describe("Tarif, deux décimales au plus. 0 pour une entrée offerte"),
  quota: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Places ouvertes pour ce tarif. Omis, la vente n'est pas plafonnée"),
});

export const registerCreateEventDraft: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "create_event_draft",
    {
      title: "Créer un brouillon d'évènement",
      description: [
        "Crée un évènement en brouillon. Le statut est forcé côté serveur :",
        "cet outil ne peut pas publier, quoi qu'on lui demande.",
        "Le brouillon n'est visible que du back-office, aucune inscription ne s'ouvre,",
        "et il reste à relire puis à publier depuis l'interface.",
        "Le visuel d'en-tête ne se pose pas ici : il se téléverse depuis le back-office.",
      ].join(" "),
      inputSchema: {
        title: z.string().trim().min(1).max(250),
        date_event: isoDate.describe("Date et heure de tenue de l'évènement"),
        date_closure: isoDate
          .optional()
          .describe(
            "Clôture des inscriptions. Omise, elle est posée à la date de l'évènement — les inscriptions restent ouvertes jusqu'au bout",
          ),
        description: z.string().trim().min(1).optional(),
        location: z.string().trim().min(1).max(250).optional(),
        is_public: z
          .boolean()
          .default(false)
          .describe(
            "false : réservé aux membres. true : visible du site public une fois publié",
          ),
        tickets: z
          .array(ticketSchema)
          .max(2)
          .default([])
          .describe(
            "Grille tarifaire. Sans billet, l'évènement est gratuit. Au plus un tarif par public",
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
        // Le backend exige la clôture ; l'agent, lui, n'a pas de raison de
        // l'inventer. La caler sur la date de l'évènement dit exactement ce que
        // « pas de clôture anticipée » veut dire, et reste modifiable ensuite.
        const dateClosure = args.date_closure ?? args.date_event;

        if (Date.parse(dateClosure) > Date.parse(args.date_event)) {
          return errorResult(
            "La clôture des inscriptions ne peut pas être postérieure à l'évènement",
          );
        }

        const created = await api.post<CreateEventResult>("/events", {
          title: args.title,
          description: args.description,
          location: args.location,
          dateEvent: args.date_event,
          dateClosure,
          isPublic: args.is_public,
          // Forcé, et non repris d'un paramètre : c'est la garantie qui tient
          // même si cet outil est appelé par un autre client que l'agent prévu.
          status: EVENT_STATUS_BY_NAME.draft,
          tickets: args.tickets.map((ticket) => ({
            name: ticket.audience,
            price: ticket.price,
            ...(ticket.quota === undefined ? {} : { quota: ticket.quota }),
          })),
        });

        return jsonResult({
          eventId: created.eventId,
          ticketIds: created.ticketIds,
          status: "draft",
          message:
            "Brouillon créé. Il n'est visible que du back-office : la publication reste un geste humain.",
        });
      }),
  );
};
