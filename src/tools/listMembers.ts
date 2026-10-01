import { z } from "zod";

import type { Paginated } from "../clients/massApi.js";
import { jsonResult } from "../shared/result.js";
import {
  MEMBER_STATUS_BY_NAME,
  guarded,
  memberStatusName,
  paginationShape,
  type ToolRegistrar,
} from "./shared.js";

type MemberRow = {
  id: string;
  matricule: string | null;
  lastname: string | null;
  firstname: string | null;
  phone: string | null;
  birthdate: string | null;
  status: number | null;
  createdAt: string | null;
  user: { id: string; email: string } | null;
  category: { id: string; code: string; title: string } | null;
  lastMembershipDate: string | null;
};

export const registerListMembers: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "list_members",
    {
      title: "Lister les membres",
      description: [
        "Liste paginée du fichier des adhérents : matricule, identité, catégorie, statut,",
        "et date de la dernière adhésion enregistrée.",
        "Données personnelles : à ne rapporter que dans la réponse demandée, jamais en vrac.",
        "Pour compter ou agréger sur l'ensemble du fichier, utiliser query_analytics.",
      ].join(" "),
      inputSchema: {
        ...paginationShape,
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Recherche libre sur le matricule, le nom, le prénom, l'email ou le téléphone",
          ),
        status: z
          .enum(["inactive", "active", "deleted"])
          .optional()
          .describe(
            "'inactive' : adhésion en attente de validation. 'active' : membre à jour. Sans filtre, tous",
          ),
        category_id: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Identifiant de catégorie de membre (branche)"),
        sort_by: z
          .enum([
            "matricule",
            "lastname",
            "firstname",
            "createdAt",
            "status",
            "category",
            "lastMembershipDate",
          ])
          .default("lastMembershipDate"),
        sort_order: z.enum(["asc", "desc"]).default("desc"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const page = await api.get<Paginated<MemberRow>>("/members", {
          page: args.page,
          limit: args.limit,
          search: args.search,
          status:
            args.status === undefined
              ? undefined
              : MEMBER_STATUS_BY_NAME[args.status],
          categoryId: args.category_id,
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
        });

        return jsonResult({
          total: page.total,
          page: page.page,
          totalPages: page.totalPages,
          members: page.records.map((member) => ({
            id: member.id,
            matricule: member.matricule,
            name: [member.firstname, member.lastname].filter(Boolean).join(" "),
            email: member.user?.email ?? null,
            phone: member.phone,
            category: member.category?.title ?? null,
            status: memberStatusName(member.status),
            lastMembershipDate: member.lastMembershipDate,
            createdAt: member.createdAt,
          })),
        });
      }),
  );
};
