import { z } from "zod";

import { errorResult, jsonResult } from "../shared/result.js";
import {
  EVENT_STATUS_BY_NAME,
  eventStatusName,
  guarded,
  isoDate,
  type ToolRegistrar,
} from "./shared.js";

type EventDetail = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  dateEvent: string | null;
  dateClosure: string | null;
  banner: string | null;
  isPublic: boolean;
  status: number;
  tickets: {
    id: string;
    name: string | null;
    price: number | null;
    quota: number | null;
    status: number;
  }[];
};

const EVENT_TICKET_ACTIVE = 5;

export const registerUpdateDraft: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "update_draft",
    {
      title: "Modifier un brouillon",
      description: [
        "Modifie un brouillon d'évènement, champ par champ : seuls les champs fournis changent,",
        "les autres sont reconduits tels quels.",
        "L'itération conversationnelle passe par ici — « déplace-le à 18h », « ajoute le lieu ».",
        "Refuse tout évènement qui n'est pas en brouillon : un évènement publié ou annulé",
        "porte des inscriptions, et se modifie depuis le back-office.",
        "Ne peut pas changer le statut : publier reste un geste humain.",
      ].join(" "),
      inputSchema: {
        resource_type: z
          .enum(["event"])
          .default("event")
          .describe(
            "Nature du brouillon. Seuls les évènements sont modifiables pour l'instant",
          ),
        resource_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .describe("Identifiant du brouillon, rendu par create_event_draft"),
        title: z.string().trim().min(1).max(250).optional(),
        description: z.string().trim().min(1).optional(),
        location: z.string().trim().min(1).max(250).optional(),
        date_event: isoDate.optional(),
        date_closure: isoDate.optional(),
        is_public: z.boolean().optional(),
        tickets: z
          .array(
            z.object({
              audience: z.enum(["member", "public"]),
              price: z.number().nonnegative().multipleOf(0.01),
              quota: z.number().int().positive().optional(),
            }),
          )
          .max(2)
          .optional()
          .describe(
            "Remplace la grille tarifaire entière. Omis, elle est reconduite. Tableau vide : l'évènement devient gratuit",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const current = await api.get<EventDetail>(
          `/events/${encodeURIComponent(args.resource_id)}`,
        );

        // Le contrôle est ici et non côté agent : c'est la seule barrière qui
        // tienne si l'outil est appelé autrement que par la conversation
        // prévue. Un évènement publié porte des inscriptions déjà prises ;
        // en déplacer la date sans prévenir personne serait la pire des
        // modifications silencieuses.
        if (current.status !== EVENT_STATUS_BY_NAME.draft) {
          return errorResult(
            `L'évènement ${current.id} est en statut « ${eventStatusName(current.status)} » : seuls les brouillons sont modifiables par cet outil. Passer par le back-office.`,
            { eventId: current.id, status: eventStatusName(current.status) },
          );
        }

        // Le backend attend l'évènement entier — `updateEventSchema` reprend
        // exactement le schéma de création. La fusion se fait donc ici, pour
        // que l'agent puisse n'envoyer que ce qui change.
        const dateEvent = args.date_event ?? current.dateEvent;
        const dateClosure = args.date_closure ?? current.dateClosure;

        if (dateEvent === null) {
          return errorResult(
            "Ce brouillon n'a pas de date d'évènement : la renseigner avec date_event dans le même appel.",
          );
        }

        const resolvedClosure = dateClosure ?? dateEvent;
        if (Date.parse(resolvedClosure) > Date.parse(dateEvent)) {
          return errorResult(
            "La clôture des inscriptions ne peut pas être postérieure à l'évènement. Ajuster date_closure dans le même appel.",
          );
        }

        const tickets =
          args.tickets?.map((ticket) => ({
            name: ticket.audience,
            price: ticket.price,
            ...(ticket.quota === undefined ? {} : { quota: ticket.quota }),
          })) ??
          // Les tarifs retirés ne sont pas reconduits : ils sont conservés en
          // base pour les inscriptions qu'ils portent, mais les renvoyer les
          // rouvrirait à la vente — le service les rapproche par leur nom.
          current.tickets
            .filter((ticket) => ticket.status === EVENT_TICKET_ACTIVE)
            .map((ticket) => ({
              name: ticket.name ?? "public",
              price: ticket.price ?? 0,
              ...(ticket.quota === null ? {} : { quota: ticket.quota }),
            }));

        await api.put(`/events/${encodeURIComponent(args.resource_id)}`, {
          title: args.title ?? current.title,
          description: args.description ?? current.description ?? undefined,
          location: args.location ?? current.location ?? undefined,
          dateEvent,
          dateClosure: resolvedClosure,
          // Le lien d'une bannière déjà stockée est accepté tel quel : c'est
          // ainsi que le back-office reconduit un visuel inchangé.
          ...(current.banner === null ? {} : { banner: current.banner }),
          isPublic: args.is_public ?? current.isPublic,
          // Reconduit depuis la lecture, jamais depuis un paramètre : cet outil
          // ne publie pas.
          status: EVENT_STATUS_BY_NAME.draft,
          tickets,
        });

        return jsonResult({
          eventId: current.id,
          status: "draft",
          updated: Object.keys(args).filter(
            (key) => !["resource_type", "resource_id"].includes(key),
          ),
          message: "Brouillon mis à jour. Toujours pas publié.",
        });
      }),
  );
};
