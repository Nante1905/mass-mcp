import { z } from "zod";

import type { Paginated } from "../clients/massApi.js";
import { jsonResult } from "../shared/result.js";
import {
  attendanceName,
  eventStatusName,
  guarded,
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
  createdAt: string | null;
  tickets: {
    id: string;
    name: string | null;
    price: number | null;
    quota: number | null;
    status: number;
  }[];
};

type ParticipantRow = {
  id: string;
  audience: "member" | "public";
  memberId: string | null;
  lastName: string | null;
  firstName: string | null;
  email: string | null;
  phone: string | null;
  ticket: { id: string; name: string | null; price: number | null } | null;
  paymentRef: string | null;
  attended: number;
  attendedAt: string | null;
  createdAt: string | null;
};

export const registerGetEventDetails: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "get_event_details",
    {
      title: "Détails d'un évènement",
      description: [
        "Fiche complète d'un évènement : description, lieu, dates, visibilité, grille tarifaire,",
        "et la liste des inscrits avec leur pointage de présence.",
        "Les identifiants d'inscription rendus ici (EMR… pour un membre, EPR… pour un visiteur)",
        "sont ceux qu'attend mark_attendance.",
      ].join(" "),
      inputSchema: {
        event_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .describe("Identifiant de l'évènement, tel que rendu par list_events"),
        include_participants: z
          .boolean()
          .default(true)
          .describe("Joindre la liste des inscrits à la fiche"),
        participants_limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("Nombre d'inscrits rapportés, 100 au plus"),
        attended: z
          .enum(["registered", "present"])
          .optional()
          .describe(
            "Filtre le pointage : 'registered' les inscrits pas encore émargés, 'present' ceux venus. Sans filtre, les deux",
          ),
        audience: z
          .enum(["member", "public", "all"])
          .default("all")
          .describe("Registre interrogé : membres, visiteurs, ou les deux"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const event = await api.get<EventDetail>(
          `/events/${encodeURIComponent(args.event_id)}`,
        );

        const base = {
          id: event.id,
          title: event.title,
          description: event.description,
          location: event.location,
          dateEvent: event.dateEvent,
          dateClosure: event.dateClosure,
          isPublic: event.isPublic,
          status: eventStatusName(event.status),
          createdAt: event.createdAt,
          hasBanner: event.banner !== null,
          tickets: event.tickets.map((ticket) => ({
            id: ticket.id,
            audience: ticket.name,
            price: ticket.price,
            quota: ticket.quota,
            open: ticket.status === 5,
          })),
        };

        if (!args.include_participants) {
          return jsonResult(base);
        }

        const participants = await api.get<Paginated<ParticipantRow>>(
          `/events/${encodeURIComponent(args.event_id)}/participations`,
          {
            page: 1,
            limit: args.participants_limit,
            audience: args.audience,
            attended:
              args.attended === undefined
                ? undefined
                : args.attended === "present"
                  ? 5
                  : 0,
          },
        );

        return jsonResult({
          ...base,
          participants: {
            total: participants.total,
            // Le total porte sur le filtre demandé ; `reported` dit combien de
            // lignes sont effectivement dans cette réponse. Sans cette
            // distinction, un agent conclut de vingt lignes que vingt personnes
            // sont inscrites.
            reported: participants.records.length,
            records: participants.records.map((row) => ({
              registrationId: row.id,
              audience: row.audience,
              memberId: row.memberId,
              name: [row.firstName, row.lastName].filter(Boolean).join(" "),
              email: row.email,
              phone: row.phone,
              ticket: row.ticket?.name ?? null,
              paymentRef: row.paymentRef,
              attendance: attendanceName(row.attended),
              attendedAt: row.attendedAt,
            })),
          },
        });
      }),
  );
};
