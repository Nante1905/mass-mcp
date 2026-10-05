import { z } from "zod";

import { errorResult, jsonResult } from "../shared/result.js";
import { guarded, type ToolRegistrar } from "./shared.js";

/**
 * Version du format rendu au front.
 *
 * L'interface dessine à partir de cette spécification sans connaître l'outil :
 * un changement de forme doit pouvoir se détecter plutôt que s'afficher en
 * graphique vide.
 */
const CHART_SPEC_VERSION = 1;

const MAX_CATEGORIES = 200;
const MAX_SERIES = 10;
const MAX_RAW_VALUES = 5_000;
const MAX_BINS = 100;

const CHART_TYPES = [
  "bar",
  "line",
  "area",
  "pie",
  "histogram",
  "scatter",
] as const;

type ChartType = (typeof CHART_TYPES)[number];

type Bin = { from: number; to: number; count: number };

/**
 * Supprime le bruit des flottants (`0.30000000000000004`) dans les bornes de
 * classes : elles finissent en étiquettes d'axe, lues par un humain.
 */
const tidy = (value: number): number => Number(value.toPrecision(6));

/**
 * Règle de Sturges : un nombre de classes qui croît avec le logarithme de
 * l'effectif. Sans elle, le modèle choisit au hasard, et un histogramme à
 * cinquante classes sur trente valeurs n'a qu'une barre par classe.
 */
const sturges = (count: number): number =>
  Math.min(MAX_BINS, Math.max(1, Math.ceil(Math.log2(count) + 1)));

/**
 * Répartit les valeurs brutes en classes de largeur égale.
 *
 * Le calcul est fait ici et non par le modèle : compter des milliers de valeurs
 * dans des intervalles est exactement ce qu'un modèle fait mal, et une erreur
 * d'un effectif ne se verrait pas sur le graphique.
 */
const binValues = (
  values: number[],
  binCount: number | undefined,
  binWidth: number | undefined,
): Bin[] | string => {
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Toutes les valeurs égales : une seule classe, de largeur nulle. La diviser
  // produirait des classes vides autour d'une barre unique.
  if (min === max) {
    return [{ from: tidy(min), to: tidy(max), count: values.length }];
  }

  const width = binWidth ?? (max - min) / (binCount ?? sturges(values.length));
  // Une largeur imposée exprime des tranches « rondes » (tranches d'âge de
  // 5 ans) : elles s'alignent sur ses multiples — 15-20, 20-25 — et non sur le
  // minimum observé, qui donnerait 18-23, 23-28.
  const start = binWidth === undefined ? min : Math.floor(min / width) * width;
  const count = Math.max(1, Math.ceil((max - start) / width));

  if (count > MAX_BINS) {
    return `bin_width = ${binWidth} produirait ${count} classes sur l'étendue ${tidy(min)} – ${tidy(max)} : ${MAX_BINS} au plus. Élargir bin_width ou passer par bin_count.`;
  }

  // Toutes les classes ont la même largeur, la dernière comprise : une
  // dernière classe rognée au maximum observé aurait la même barre que les
  // autres pour un intervalle plus court, et l'effectif s'y lirait faussé.
  const bins: Bin[] = Array.from({ length: count }, (_, index) => ({
    from: tidy(start + index * width),
    to: tidy(start + (index + 1) * width),
    count: 0,
  }));

  for (const value of values) {
    // Le maximum peut tomber exactement sur la borne haute de la dernière
    // classe : il y est rangé (classe fermée à droite) plutôt que dans une
    // classe supplémentaire à un seul élément.
    const index = Math.min(count - 1, Math.floor((value - start) / width));
    bins[index]!.count += 1;
  }

  return bins;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const seriesShape = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Nom de la série, affiché en légende"),
  values: z
    .array(z.number().nullable())
    .max(MAX_CATEGORIES)
    .optional()
    .describe(
      "Une valeur par élément de labels, dans le même ordre. null marque une donnée manquante (trou dans la courbe). Pour bar, line, area et pie",
    ),
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .max(MAX_RAW_VALUES)
    .optional()
    .describe("Couples (x, y). Pour scatter uniquement"),
});

type SeriesInput = z.infer<typeof seriesShape>;

/**
 * Contrôle de cohérence entre le type de graphique et les données fournies.
 *
 * Le schéma ne peut pas l'exprimer : `registerTool` attend un objet plat, pas
 * une union discriminée. Le contrôle est donc fait ici, et chaque refus dit quoi
 * corriger — un champ ignoré en silence donnerait un graphique faux sans que
 * personne ne le remarque.
 */
const checkCategorical = (
  type: ChartType,
  labels: string[] | undefined,
  series: SeriesInput[] | undefined,
): string | null => {
  if (!labels?.length) {
    return `Un graphique '${type}' attend labels : une étiquette par catégorie ou par point de l'axe horizontal.`;
  }
  if (!series?.length) {
    return `Un graphique '${type}' attend au moins une série dans series, chacune avec values.`;
  }

  for (const entry of series) {
    if (!entry.values) {
      return `La série « ${entry.name} » n'a pas de values. points est réservé à scatter.`;
    }
    if (entry.values.length !== labels.length) {
      return `La série « ${entry.name} » compte ${entry.values.length} valeurs pour ${labels.length} labels : il en faut exactement une par label, null pour une donnée manquante.`;
    }
  }

  if (type === "pie") {
    if (series.length !== 1) {
      return `Un camembert ne porte qu'une série (${series.length} reçues). Pour comparer plusieurs séries, utiliser 'bar'.`;
    }
    const values = series[0]!.values!;
    if (values.some((value) => value === null || value < 0)) {
      return "Un camembert n'accepte ni valeur négative ni null : chaque part doit être une quantité positive ou nulle.";
    }
    if (values.every((value) => value === 0)) {
      return "Toutes les parts du camembert sont nulles : il n'y a rien à représenter.";
    }
  }

  return null;
};

export const registerGenerateGraph: ToolRegistrar = (server) => {
  server.registerTool(
    "generate_graph",
    {
      title: "Générer un graphique",
      description: [
        "Construit un graphique que l'interface du back-office affiche à l'administrateur :",
        "barres, courbe, aire, camembert, histogramme ou nuage de points.",
        "",
        "Cet outil ne lit aucune donnée : il met en forme celles qu'on lui passe. Obtenir",
        "d'abord les chiffres avec get_attendance_stats, get_finance_summary ou",
        "query_analytics (en agrégeant côté SQL), puis les transmettre tels quels —",
        "ne jamais inventer ni arrondir une valeur pour remplir un graphique.",
        "",
        "Choisir le type :",
        "- bar : comparer des catégories (présence par évènement, adhésions par statut) ;",
        "- line / area : une évolution dans le temps, labels dans l'ordre chronologique ;",
        "- pie : les parts d'un tout, une seule série, une dizaine de parts au plus ;",
        "- histogram : la distribution d'une mesure — passer les valeurs brutes dans",
        "  values, l'outil calcule les classes et les effectifs ;",
        "- scatter : la relation entre deux mesures, en couples (x, y).",
        "",
        "Le graphique s'affiche de lui-même : dans la réponse, commenter ce qu'il montre",
        "plutôt que recopier les chiffres en tableau.",
      ].join("\n"),
      inputSchema: {
        chart_type: z.enum(CHART_TYPES).describe("Type de graphique"),
        title: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("Titre affiché au-dessus du graphique"),
        x_label: z
          .string()
          .trim()
          .max(80)
          .optional()
          .describe("Légende de l'axe horizontal. Sans valeur, l'axe n'est pas titré"),
        y_label: z
          .string()
          .trim()
          .max(80)
          .optional()
          .describe(
            "Légende de l'axe vertical. Sans valeur, « Effectif » pour un histogramme, aucune sinon",
          ),
        unit: z
          .string()
          .trim()
          .max(20)
          .optional()
          .describe("Unité des valeurs, reprise dans les infobulles : '%', 'Ar', 'inscrits'…"),
        labels: z
          .array(z.string().trim().max(80))
          .max(MAX_CATEGORIES)
          .optional()
          .describe(
            "Catégories ou points de l'axe horizontal, dans l'ordre d'affichage. Requis pour bar, line, area et pie ; ignoré sinon",
          ),
        series: z
          .array(seriesShape)
          .max(MAX_SERIES)
          .optional()
          .describe(
            `Séries à tracer, ${MAX_SERIES} au plus. Requis pour bar, line, area, pie (une seule série) et scatter`,
          ),
        stacked: z
          .boolean()
          .default(false)
          .describe("Empiler les séries. Pour bar et area uniquement"),
        values: z
          .array(z.number())
          .max(MAX_RAW_VALUES)
          .optional()
          .describe(
            `Valeurs brutes, ${MAX_RAW_VALUES} au plus. Pour histogram uniquement : l'outil les répartit en classes`,
          ),
        bin_count: z
          .number()
          .int()
          .min(1)
          .max(MAX_BINS)
          .optional()
          .describe(
            "Nombre de classes de l'histogramme. Sans valeur ni bin_width, déterminé par la règle de Sturges",
          ),
        bin_width: z
          .number()
          .positive()
          .optional()
          .describe(
            "Largeur des classes de l'histogramme (ex. 5 pour des tranches d'âge de 5 ans). Prioritaire sur bin_count",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      guarded(async () => {
        const type = args.chart_type;
        const frame = {
          type,
          title: args.title,
          xLabel: args.x_label ?? null,
          yLabel: args.y_label ?? (type === "histogram" ? "Effectif" : null),
          unit: args.unit ?? null,
        };

        if (type === "histogram") {
          if (!args.values?.length) {
            return errorResult(
              "Un histogramme attend les valeurs brutes dans values (une par individu ou par observation), pas des effectifs déjà comptés. Pour des effectifs déjà agrégés, utiliser 'bar'.",
            );
          }

          const bins = binValues(args.values, args.bin_count, args.bin_width);
          if (typeof bins === "string") {
            return errorResult(bins);
          }

          const total = args.values.reduce((sum, value) => sum + value, 0);

          return jsonResult({
            kind: "chart",
            version: CHART_SPEC_VERSION,
            chart: {
              ...frame,
              stacked: false,
              labels: bins.map((bin) => `${bin.from} – ${bin.to}`),
              series: [{ name: "Effectif", data: bins.map((bin) => bin.count) }],
              bins,
            },
            // Rendu au modèle pour qu'il commente la distribution sans avoir à
            // la recalculer de tête à partir des classes.
            summary: {
              count: args.values.length,
              min: tidy(Math.min(...args.values)),
              max: tidy(Math.max(...args.values)),
              mean: tidy(total / args.values.length),
              median: tidy(median(args.values)),
            },
          });
        }

        if (args.values) {
          return errorResult(
            `values est réservé à histogram. Pour un graphique '${type}', passer les données dans series.`,
          );
        }

        if (type === "scatter") {
          if (!args.series?.length) {
            return errorResult(
              "Un nuage de points attend au moins une série dans series, chacune avec points : [{ x, y }, …].",
            );
          }
          const empty = args.series.find((entry) => !entry.points?.length);
          if (empty) {
            return errorResult(
              `La série « ${empty.name} » n'a pas de points. Un nuage de points se décrit en couples { x, y }, pas en values.`,
            );
          }

          return jsonResult({
            kind: "chart",
            version: CHART_SPEC_VERSION,
            chart: {
              ...frame,
              stacked: false,
              series: args.series.map((entry) => ({
                name: entry.name,
                points: entry.points,
              })),
            },
          });
        }

        const problem = checkCategorical(type, args.labels, args.series);
        if (problem) {
          return errorResult(problem);
        }

        return jsonResult({
          kind: "chart",
          version: CHART_SPEC_VERSION,
          chart: {
            ...frame,
            // Empiler n'a de sens que pour des quantités qui s'additionnent
            // sur un même axe ; sur une courbe ou un camembert, l'option
            // fausserait la lecture.
            stacked: (type === "bar" || type === "area") && args.stacked,
            labels: args.labels,
            series: args.series!.map((entry) => ({
              name: entry.name,
              data: entry.values,
            })),
          },
        });
      }),
  );
};
