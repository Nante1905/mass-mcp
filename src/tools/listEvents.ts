import { z } from "zod";

import type { Paginated } from "../clients/massApi.js";
import { jsonResult } from "../shared/result.js";
import {
  EVENT_STATUS_BY_NAME,
  eventStatusName,
  guarded,
  paginationShape,
  type ToolRegistrar,
} from "./shared.js";

type EventTicket = {
  id: string;
  name: string | null;
  price: number | null;
  quota: number | null;
  status: number;
};

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  dateEvent: string | null;
  dateClosure: string | null;
  isPublic: boolean;
  status: number;
  createdAt: string | null;
  tickets: EventTicket[];
};

export const registerListEvents: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "list_events",
    {
      title: "Lister les évènements",
      description: [
        "Liste paginée des évènements du back-office, brouillons compris.",
        "Filtrable par période, statut, visibilité et recherche libre (titre et lieu).",
        "Rend une page : pour compter ou agréger sur l'ensemble, utiliser query_analytics.",
      ].join(" "),
      inputSchema: {
        ...paginationShape,
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Recherche libre sur le titre et le lieu"),
        status: z
          .enum(["draft", "published", "cancelled"])
          .optional()
          .describe(
            "Sans filtre, tous les statuts remontent — c'est l'agenda complet du back-office",
          ),
        period: z
          .enum(["all", "upcoming", "past"])
          .default("all")
          .describe(
            "Par rapport à l'instant de l'appel. Un évènement sans date ne remonte qu'en 'all'",
          ),
        is_public: z
          .boolean()
          .optional()
          .describe(
            "true : ouvert au public. false : réservé aux membres. Sans filtre : les deux",
          ),
        sort_by: z
          .enum(["dateEvent", "title", "createdAt"])
          .default("dateEvent"),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const page = await api.get<Paginated<EventRow>>("/events", {
          page: args.page,
          limit: args.limit,
          search: args.search,
          status:
            args.status === undefined
              ? undefined
              : EVENT_STATUS_BY_NAME[args.status],
          period: args.period,
          isPublic: args.is_public,
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
        });

        return jsonResult({
          total: page.total,
          page: page.page,
          totalPages: page.totalPages,
          events: page.records.map((event) => ({
            id: event.id,
            title: event.title,
            location: event.location,
            dateEvent: event.dateEvent,
            dateClosure: event.dateClosure,
            isPublic: event.isPublic,
            status: eventStatusName(event.status),
            // La description n'est pas reprise : sur vingt lignes elle pèse plus
            // que tout le reste, et la fiche est à un appel de distance.
            ticketCount: event.tickets.length,
            tickets: event.tickets.map((ticket) => ({
              id: ticket.id,
              audience: ticket.name,
              price: ticket.price,
              quota: ticket.quota,
            })),
          })),
        });
      }),
  );
};
