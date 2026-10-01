import "dotenv/config";
import { z } from "zod";

/**
 * Configuration du serveur, lue une fois au démarrage.
 *
 * Une variable manquante ou aberrante arrête le processus ici plutôt qu'au
 * premier appel d'outil : une URL d'API vide se lirait autrement comme une
 * panne du backend, et on chercherait au mauvais endroit.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),

  // Liste blanche d'origines, séparées par des virgules. Vide, la protection
  // reste éteinte — voir `.env.example`.
  MCP_ALLOWED_ORIGINS: z.string().trim().optional(),

  MASS_API_URL: z.url().default("http://localhost:3000/api/v1"),
  MASS_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Les cinq suivantes vont ensemble : ou bien toutes renseignées, ou bien
  // aucune. Le contrôle est fait après l'analyse, `superRefine` n'apporterait
  // rien de plus lisible ici.
  ANALYTICS_DB_HOST: z.string().trim().min(1).optional(),
  ANALYTICS_DB_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  ANALYTICS_DB_USER: z.string().trim().min(1).optional(),
  ANALYTICS_DB_PASSWORD: z.string().optional(),
  ANALYTICS_DB_NAME: z.string().trim().min(1).optional(),
  ANALYTICS_DB_SSL: z.stringbool().default(false),

  ANALYTICS_MAX_ROWS: z.coerce.number().int().min(1).max(5_000).default(500),
  ANALYTICS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(5_000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    "Configuration invalide :\n" +
      z.prettifyError(parsed.error).replace(/^/gm, "  "),
  );
  process.exit(1);
}

const env = parsed.data;

/**
 * Connexion de lecture d'`query_analytics`, ou `null` quand elle n'est pas
 * configurée.
 *
 * L'absence n'est pas une faute : un déploiement qui ne veut pas ouvrir la base
 * garde les onze autres outils. C'est l'outil lui-même qui répondra qu'il est
 * hors service, avec la raison — plutôt qu'un démarrage refusé qui priverait de
 * tout le reste.
 */
const analyticsDatabase =
  env.ANALYTICS_DB_HOST && env.ANALYTICS_DB_USER && env.ANALYTICS_DB_NAME
    ? {
        host: env.ANALYTICS_DB_HOST,
        port: env.ANALYTICS_DB_PORT,
        user: env.ANALYTICS_DB_USER,
        password: env.ANALYTICS_DB_PASSWORD ?? "",
        database: env.ANALYTICS_DB_NAME,
        ssl: env.ANALYTICS_DB_SSL,
      }
    : null;

export const config = {
  http: {
    port: env.PORT,
    host: env.HOST,
    allowedOrigins:
      env.MCP_ALLOWED_ORIGINS?.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0) ?? [],
  },
  massApi: {
    // La barre finale est retirée une fois pour toutes : les chemins des
    // clients commencent tous par une barre, et `.../v1//events` n'est pas la
    // même route pour Express.
    baseUrl: env.MASS_API_URL.replace(/\/+$/, ""),
    timeoutMs: env.MASS_API_TIMEOUT_MS,
  },
  analytics: {
    database: analyticsDatabase,
    maxRows: env.ANALYTICS_MAX_ROWS,
    timeoutMs: env.ANALYTICS_TIMEOUT_MS,
  },
} as const;

export type AppConfig = typeof config;
