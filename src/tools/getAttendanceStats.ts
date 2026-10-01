import { z } from "zod";

import {
  isAnalyticsConfigured,
  runReadOnlyQuery,
} from "../analytics/readonlyPool.js";
import { errorResult, jsonResult } from "../shared/result.js";
import {
  ATTENDANCE_BY_NAME,
  EVENT_REGISTRATION_DELETED,
  eventStatusName,
  guarded,
  isoDate,
  type ToolRegistrar,
} from "./shared.js";

/**
 * Les deux registres réunis, ramenés aux seules colonnes du calcul.
 *
 * Une présence ne se compte jamais sur une seule table : les membres sont dans
 * `event_member_registration`, les visiteurs dans `event_public_registration`.
 * Les lignes supprimées sont écartées des deux côtés — elles ont rendu leur
 * place, les compter fausserait le dénominateur.
 *
 * `is distinct from` et non `<>` : la colonne est nullable, et `status <> -5`
 * écarterait silencieusement toute ligne dont le statut est nul.
 */
const REGISTRATIONS_CTE = `
  with registrations as (
    select id_event, id_member, attended, 'member'::text as audience
    from event_member_registration
    where status is distinct from ${EVENT_REGISTRATION_DELETED}
    union all
    select id_event, null::varchar as id_member, attended, 'public'::text as audience
    from event_public_registration
    where status is distinct from ${EVENT_REGISTRATION_DELETED}
  )
`;

/**
 * Filtres communs aux quatre requêtes, dans le même ordre de paramètres.
 *
 * La période porte sur la date de l'évènement et non sur celle de l'inscription :
 * « le taux de présence en mars » désigne les évènements de mars, pas les
 * inscriptions prises en mars pour un évènement d'avril.
 *
 * Le motif `$n is null or …` évite de construire la clause dynamiquement : la
 * requête reste un texte constant, et un filtre absent n'a aucun effet.
 */
const FILTERS = `
  where ($1::timestamp is null or e.date_event >= $1::timestamp)
    and ($2::timestamp is null or e.date_event <= $2::timestamp)
    and ($3::varchar is null or e.id = $3::varchar)
    and ($4::varchar is null or r.id_member = $4::varchar)
    and ($5::text is null or r.audience = $5::text)
`;

const PRESENT = ATTENDANCE_BY_NAME.present;

const TOTALS_QUERY = `
  ${REGISTRATIONS_CTE}
  select
    count(*)::int as registered,
    count(*) filter (where r.attended = ${PRESENT})::int as attended,
    count(distinct r.id_event)::int as events
  from registrations r
  join events e on e.id = r.id_event
  ${FILTERS}
`;

const BY_EVENT_QUERY = `
  ${REGISTRATIONS_CTE}
  select
    e.id as event_id,
    e.title,
    e.date_event,
    e.status,
    count(*)::int as registered,
    count(*) filter (where r.attended = ${PRESENT})::int as attended
  from registrations r
  join events e on e.id = r.id_event
  ${FILTERS}
  group by e.id, e.title, e.date_event, e.status
  order by e.date_event desc nulls last
  limit $6
`;

/**
 * Les visiteurs n'ont pas de fiche membre : `id_member is not null` les écarte.
 * Un classement par membre ne peut pas les inclure, et les compter dans un
 * « autre » agrégé ferait un membre fantôme en tête de liste.
 */
const BY_MEMBER_QUERY = `
  ${REGISTRATIONS_CTE}
  select
    m.id as member_id,
    m.matricule,
    m.firstname,
    m.lastname,
    count(*)::int as registered,
    count(*) filter (where r.attended = ${PRESENT})::int as attended
  from registrations r
  join events e on e.id = r.id_event
  join members m on m.id = r.id_member
  ${FILTERS} and r.id_member is not null
  group by m.id, m.matricule, m.firstname, m.lastname
  order by count(*) filter (where r.attended = ${PRESENT}) desc, count(*) desc
  limit $6
`;

const BY_PERIOD_QUERY = `
  ${REGISTRATIONS_CTE}
  select
    to_char(date_trunc('month', e.date_event), 'YYYY-MM') as period,
    count(distinct e.id)::int as events,
    count(*)::int as registered,
    count(*) filter (where r.attended = ${PRESENT})::int as attended
  from registrations r
  join events e on e.id = r.id_event
  ${FILTERS} and e.date_event is not null
  group by 1
  order by 1 desc
  limit $6
`;

const QUERY_BY_GROUPING = {
  event: BY_EVENT_QUERY,
  member: BY_MEMBER_QUERY,
  period: BY_PERIOD_QUERY,
} as const;

/**
 * Taux de présence, en pourcentage entier.
 *
 * Nul quand personne n'est inscrit : `0 %` se lirait comme « personne n'est
 * venu » alors qu'il n'y avait rien à mesurer.
 */
const rate = (attended: number, registered: number): number | null =>
  registered === 0 ? null : Math.round((attended / registered) * 100);

type TotalsRow = { registered: number; attended: number; events: number };

export const registerGetAttendanceStats: ToolRegistrar = (server) => {
  server.registerTool(
    "get_attendance_stats",
    {
      title: "Taux de présence",
      description: [
        "Taux de présence agrégé, par évènement, par membre ou par mois.",
        "Réunit les deux registres — membres et visiteurs — et écarte les inscriptions annulées.",
        "",
        "Répond sur l'ensemble des données, pas sur une page : c'est l'outil des questions",
        "« quel évènement remplit le mieux », « qui vient le plus souvent », « la présence",
        "baisse-t-elle depuis janvier ».",
        "",
        "Pour la fiche de présence nominative d'un évènement précis, utiliser get_event_details.",
        "Pour un croisement que ce découpage ne couvre pas, query_analytics.",
      ].join("\n"),
      inputSchema: {
        group_by: z
          .enum(["event", "member", "period"])
          .default("event")
          .describe(
            "Découpage. 'member' écarte les visiteurs, qui n'ont pas de fiche membre. 'period' agrège par mois",
          ),
        date_from: isoDate
          .optional()
          .describe("Début de période, sur la date de l'évènement"),
        date_to: isoDate
          .optional()
          .describe("Fin de période, sur la date de l'évènement"),
        event_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .optional()
          .describe("Restreindre à un seul évènement"),
        member_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .optional()
          .describe("Restreindre à un seul membre (écarte de fait les visiteurs)"),
        audience: z
          .enum(["member", "public"])
          .optional()
          .describe(
            "Registre retenu. Sans filtre, les membres et les visiteurs sont comptés ensemble",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Nombre de lignes du découpage, 100 au plus"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        if (!isAnalyticsConfigured()) {
          return errorResult(
            "get_attendance_stats est indisponible : la base de lecture n'est pas configurée sur ce déploiement (variables ANALYTICS_DB_*). Les présences d'un évènement précis restent lisibles avec get_event_details.",
          );
        }

        // Les requêtes sont écrites ici, pas reçues : elles ne passent donc pas
        // par le garde SQL, qui n'existe que pour ce qu'un modèle rédige. Le
        // rôle en lecture seule et la transaction `read only`, eux, s'appliquent
        // comme partout ailleurs.
        const filters = [
          args.date_from ?? null,
          args.date_to ?? null,
          args.event_id ?? null,
          args.member_id ?? null,
          args.audience ?? null,
        ];

        const [totals, grouped] = await Promise.all([
          runReadOnlyQuery(TOTALS_QUERY, filters, 1),
          runReadOnlyQuery(
            QUERY_BY_GROUPING[args.group_by],
            // Une ligne de plus que demandé : c'est ce qui permet de dire que
            // le découpage est tronqué plutôt que de le laisser passer pour
            // complet.
            [...filters, args.limit + 1],
            args.limit,
          ),
        ]);

        const summary = (totals.rows[0] ?? {
          registered: 0,
          attended: 0,
          events: 0,
        }) as unknown as TotalsRow;

        return jsonResult({
          groupBy: args.group_by,
          period: { from: args.date_from ?? null, to: args.date_to ?? null },
          overall: {
            events: summary.events,
            registered: summary.registered,
            attended: summary.attended,
            attendanceRate: rate(summary.attended, summary.registered),
          },
          truncated: grouped.truncated,
          ...(grouped.truncated
            ? {
                warning: `Découpage tronqué à ${args.limit} lignes : les totaux ci-dessus restent complets, la liste non.`,
              }
            : {}),
          rows: grouped.rows.map((row) => {
            const registered = Number(row["registered"] ?? 0);
            const attended = Number(row["attended"] ?? 0);

            const identity =
              args.group_by === "event"
                ? {
                    eventId: row["event_id"],
                    title: row["title"],
                    dateEvent: row["date_event"],
                    status: eventStatusName(Number(row["status"])),
                  }
                : args.group_by === "member"
                  ? {
                      memberId: row["member_id"],
                      matricule: row["matricule"],
                      name: [row["firstname"], row["lastname"]]
                        .filter(Boolean)
                        .join(" "),
                    }
                  : { period: row["period"], events: row["events"] };

            return {
              ...identity,
              registered,
              attended,
              attendanceRate: rate(attended, registered),
            };
          }),
        });
      }),
  );
};
