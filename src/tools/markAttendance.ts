import { z } from "zod";

import type { Paginated } from "../clients/massApi.js";
import { errorResult, jsonResult } from "../shared/result.js";
import {
  ATTENDANCE_BY_NAME,
  attendanceName,
  eventStatusName,
  guarded,
  type ToolRegistrar,
} from "./shared.js";

type EventDetail = { id: string; title: string; status: number };

type ParticipantRow = {
  id: string;
  audience: "member" | "public";
  lastName: string | null;
  firstName: string | null;
  email: string | null;
  attended: number;
};

type BatchAttendanceResult = {
  updated: string[];
  unchanged: string[];
  invitationsSent: string[];
  invitationsFailed: string[];
};

const PARTICIPANTS_PAGE_SIZE = 100;
/** Cinq pages : de quoi couvrir une fiche de présence réaliste sans boucler. */
const PARTICIPANTS_MAX_PAGES = 5;

/**
 * Fiche de présence de l'évènement, ramenée en mémoire.
 *
 * Nécessaire pour l'aperçu : le lot arrive en identifiants (`EMR0007`), et une
 * validation humaine sur des identifiants n'en est pas une — on relit des noms,
 * pas des clés. Les pages sont enchaînées et non parallélisées : le total n'est
 * connu qu'à la première réponse.
 */
const loadParticipants = async (
  get: (page: number) => Promise<Paginated<ParticipantRow>>,
): Promise<{ rows: ParticipantRow[]; complete: boolean }> => {
  const rows: ParticipantRow[] = [];
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, PARTICIPANTS_MAX_PAGES); page++) {
    const result = await get(page);
    totalPages = result.totalPages;
    rows.push(...result.records);
  }

  return { rows, complete: totalPages <= PARTICIPANTS_MAX_PAGES };
};

export const registerMarkAttendance: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "mark_attendance",
    {
      title: "Pointer des présences",
      description: [
        "Marque un ou plusieurs inscrits présents à un évènement, ou annule leur pointage.",
        "",
        "Écriture soumise à validation humaine. Appelé sans `confirmed: true`, l'outil n'écrit rien :",
        "il rend l'aperçu nominatif de ce qui serait modifié, à faire relire avant de rappeler",
        "le même appel avec `confirmed: true`.",
        "",
        "Effet de bord à annoncer : chaque personne nouvellement pointée présente reçoit",
        "par courriel son lien d'avis sur l'évènement. Un pointage par erreur envoie un vrai mail.",
        "",
        "Les identifiants attendus sont ceux de l'inscription (EMR… pour un membre, EPR… pour un",
        "visiteur), rendus par get_event_details — et non les identifiants de membre.",
      ].join("\n"),
      inputSchema: {
        event_id: z.string().trim().min(1).max(50),
        registration_ids: z
          .array(z.string().trim().min(1).max(50))
          .min(1)
          .max(100)
          .describe("Identifiants d'inscription, 100 au plus par appel"),
        attendance: z
          .enum(["present", "registered"])
          .default("present")
          .describe(
            "'present' pointe la présence. 'registered' dépointe — pour défaire une sélection cochée par erreur",
          ),
        confirmed: z
          .boolean()
          .default(false)
          .describe(
            "Doit valoir true pour que l'écriture ait lieu. À ne poser qu'après validation explicite d'un humain, jamais de sa propre initiative",
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
        const eventPath = `/events/${encodeURIComponent(args.event_id)}`;
        const target = ATTENDANCE_BY_NAME[args.attendance];

        if (args.confirmed) {
          const result = await api.patch<BatchAttendanceResult>(
            `${eventPath}/participations/attendance`,
            {
              registrationIds: args.registration_ids,
              attended: target,
            },
          );

          return jsonResult({
            applied: true,
            attendance: args.attendance,
            updated: result.updated,
            // Repointer une sélection entière n'est pas une erreur : c'est le
            // premier pointage qui fait foi, heure comprise.
            unchanged: result.unchanged,
            emailsSent: result.invitationsSent,
            emailsFailed: result.invitationsFailed,
            message:
              result.invitationsFailed.length > 0
                ? "Pointage enregistré. Certains liens d'avis n'ont pas pu partir : le mail reste à renvoyer depuis le back-office."
                : "Pointage enregistré.",
          });
        }

        // Aucune écriture au-delà de ce point : on décrit ce qui se passerait.
        const event = await api.get<EventDetail>(eventPath);
        const { rows, complete } = await loadParticipants((page) =>
          api.get<Paginated<ParticipantRow>>(`${eventPath}/participations`, {
            page,
            limit: PARTICIPANTS_PAGE_SIZE,
          }),
        );

        const byId = new Map(rows.map((row) => [row.id, row]));
        const known = args.registration_ids.filter((id) => byId.has(id));
        const unknown = args.registration_ids.filter((id) => !byId.has(id));

        const changes = known
          .map((id) => byId.get(id)!)
          .map((row) => ({
            registrationId: row.id,
            name: [row.firstName, row.lastName].filter(Boolean).join(" "),
            email: row.email,
            audience: row.audience,
            current: attendanceName(row.attended),
            wouldChange: row.attended !== target,
          }));

        const changing = changes.filter((change) => change.wouldChange);

        if (unknown.length > 0 && !complete) {
          return errorResult(
            `${unknown.length} identifiant(s) introuvable(s), mais la fiche de présence dépasse ${PARTICIPANTS_PAGE_SIZE * PARTICIPANTS_MAX_PAGES} inscrits et n'a pas pu être lue en entier : impossible de dire s'ils existent. Vérifier les identifiants avec get_event_details avant de confirmer.`,
            { unknown },
          );
        }

        return jsonResult({
          applied: false,
          confirmationRequired: true,
          event: {
            id: event.id,
            title: event.title,
            status: eventStatusName(event.status),
          },
          attendance: args.attendance,
          summary: `${changing.length} pointage(s) à ${args.attendance === "present" ? "poser" : "retirer"}, ${changes.length - changing.length} déjà dans cet état, ${unknown.length} identifiant(s) inconnu(s).`,
          emailsThatWouldBeSent:
            args.attendance === "present"
              ? changing.length
              : 0,
          changes,
          unknownRegistrationIds: unknown,
          nextStep:
            "Présenter cette liste nominative à l'utilisateur. S'il l'approuve, rappeler mark_attendance avec les mêmes paramètres et confirmed: true.",
        });
      }),
  );
};
