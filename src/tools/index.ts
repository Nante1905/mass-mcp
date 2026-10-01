import { registerCreateEmailTemplate } from "./createEmailTemplate.js";
import { registerCreateEventDraft } from "./createEventDraft.js";
import { registerGetAttendanceStats } from "./getAttendanceStats.js";
import { registerGetEventDetails } from "./getEventDetails.js";
import { registerGetFinanceSummary } from "./getFinanceSummary.js";
import { registerGetMemberDetails } from "./getMemberDetails.js";
import { registerListEvents } from "./listEvents.js";
import { registerListMembers } from "./listMembers.js";
import { registerMarkAttendance } from "./markAttendance.js";
import { registerQueryAnalytics } from "./queryAnalytics.js";
import { registerSendEmail } from "./sendEmail.js";
import { registerUpdateDraft } from "./updateDraft.js";
import type { ToolRegistrar } from "./shared.js";

/**
 * Les outils, lectures d'abord, écritures ensuite.
 *
 * L'ordre est celui dans lequel le modèle les découvre : les lectures en tête
 * parce que ce sont elles qui répondent à la plupart des demandes, et qu'une
 * écriture bien informée commence par une lecture.
 *
 * Restent à construire : `create_article_draft`, qui attend sa table côté
 * `mass-backend`, et `get_observation_forecast`, qui attend son modèle.
 */
export const TOOL_REGISTRARS: ToolRegistrar[] = [
  registerListEvents,
  registerGetEventDetails,
  registerListMembers,
  registerGetMemberDetails,
  registerGetAttendanceStats,
  registerGetFinanceSummary,
  registerQueryAnalytics,
  registerCreateEventDraft,
  registerUpdateDraft,
  registerCreateEmailTemplate,
  registerMarkAttendance,
  registerSendEmail,
];
