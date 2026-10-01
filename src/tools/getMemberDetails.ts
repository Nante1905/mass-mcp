import { z } from "zod";

import { jsonResult } from "../shared/result.js";
import {
  guarded,
  memberStatusName,
  membershipStatusName,
  paymentStatusName,
  type ToolRegistrar,
} from "./shared.js";

type MemberPayment = {
  id: string;
  amount: number | null;
  refPayement: string | null;
  status: number | null;
  idTransaction: string | null;
  method: { id: string; name: string | null } | null;
};

type MemberMembership = {
  id: string;
  dateMembership: string | null;
  status: number | null;
  motivation: string | null;
  projectIdea: string | null;
  domain: string | null;
  studyLevel: string | null;
  type: { id: string; code: string; title: string } | null;
  payment: MemberPayment | null;
};

type MemberDetail = {
  id: string;
  matricule: string | null;
  lastname: string | null;
  firstname: string | null;
  phone: string;
  birthdate: string | null;
  status: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  user: { id: string; email: string; status: number } | null;
  category: {
    id: string;
    code: string;
    title: string;
    fee: number | null;
  } | null;
  memberships: MemberMembership[];
  registeredEventsCount: number;
  attendedEventsCount: number;
  memberSince: string | null;
  lastRenewalAt: string | null;
};

export const registerGetMemberDetails: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "get_member_details",
    {
      title: "Fiche d'un membre",
      description: [
        "Dossier complet d'un adhérent : identité, branche et cotisation, historique des adhésions",
        "avec leurs paiements, et son assiduité aux évènements.",
        "",
        "C'est la fiche d'une personne : à ouvrir quand la question porte sur elle, pas pour",
        "parcourir le fichier. Pour chercher quelqu'un, list_members ; pour comparer ou classer",
        "plusieurs membres, get_attendance_stats ou query_analytics.",
        "",
        "Données personnelles, textes de motivation compris : ne rapporter que ce qui répond",
        "à la question posée.",
      ].join("\n"),
      inputSchema: {
        member_id: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .describe("Identifiant du membre (MBR…), tel que rendu par list_members"),
        include_membership_history: z
          .boolean()
          .default(true)
          .describe(
            "Joindre l'historique des adhésions et leurs paiements. false : ne garder que l'identité et les compteurs",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const member = await api.get<MemberDetail>(
          `/members/${encodeURIComponent(args.member_id)}`,
        );

        const registered = member.registeredEventsCount;
        const attended = member.attendedEventsCount;

        const base = {
          id: member.id,
          matricule: member.matricule,
          name: [member.firstname, member.lastname].filter(Boolean).join(" "),
          email: member.user?.email ?? null,
          phone: member.phone,
          birthdate: member.birthdate,
          status: memberStatusName(member.status),
          hasAccount: member.user !== null,
          category: member.category
            ? {
                id: member.category.id,
                code: member.category.code,
                title: member.category.title,
                fee: member.category.fee,
              }
            : null,
          memberSince: member.memberSince,
          lastRenewalAt: member.lastRenewalAt,
          attendance: {
            registered,
            attended,
            // Calculé ici plutôt que laissé au modèle : un taux que chacun
            // recalcule finit par être annoncé différemment d'un tour à
            // l'autre. Nul quand il n'y a aucune inscription — 0 % laisserait
            // croire à une absence, alors qu'il n'y a rien à mesurer.
            rate: registered === 0 ? null : Math.round((attended / registered) * 100),
          },
          createdAt: member.createdAt,
        };

        if (!args.include_membership_history) {
          return jsonResult({
            ...base,
            membershipCount: member.memberships.length,
          });
        }

        return jsonResult({
          ...base,
          memberships: member.memberships.map((membership) => ({
            id: membership.id,
            date: membership.dateMembership,
            status: membershipStatusName(membership.status),
            type: membership.type?.title ?? null,
            domain: membership.domain,
            studyLevel: membership.studyLevel,
            motivation: membership.motivation,
            projectIdea: membership.projectIdea,
            payment: membership.payment
              ? {
                  amount: membership.payment.amount,
                  method: membership.payment.method?.name ?? null,
                  reference: membership.payment.refPayement,
                  status: paymentStatusName(membership.payment.status),
                  // Le rapprochement comptable est ce qui distingue un paiement
                  // déclaré d'un encaissement constaté.
                  reconciled: membership.payment.idTransaction !== null,
                }
              : null,
          })),
        });
      }),
  );
};
