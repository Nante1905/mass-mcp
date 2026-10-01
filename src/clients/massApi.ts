/**
 * Enveloppe de réponse de l'API MASS (`ApiResponse` côté backend).
 *
 * `ok` est le seul champ qui fasse foi : le backend rend parfois un 200 dont
 * l'enveloppe porte `ok: false`.
 */
type ApiEnvelope<T> = {
  ok: boolean;
  payload: T;
  message: string;
  error: string;
};

/** Page rendue par les listes de l'API (`Paginated` côté backend). */
export type Paginated<T> = {
  records: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/**
 * Échec d'un appel à l'API MASS, tel que l'outil doit le rapporter.
 *
 * Le statut est conservé pour que l'outil puisse distinguer ce qui se corrige
 * — un 404 sur un identifiant inventé — de ce qui ne se corrige pas depuis la
 * conversation : un 401 sur un jeton expiré, un 403 sur un compte qui n'est
 * plus administrateur.
 */
export class MassApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "MassApiError";
  }
}

type QueryValue = string | number | boolean | undefined | null;

/**
 * Client de l'API MASS lié à un administrateur.
 *
 * Une instance par requête MCP, construite avec le jeton reçu : le serveur ne
 * détient aucune identité durable et n'a donc rien à révoquer. Un jeton expiré
 * cesse d'ouvrir l'API à la seconde où le backend le refuse, sans que le MCP
 * ait à s'en occuper.
 */
export class MassApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, { body });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown },
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      // `undefined` et `null` valent « filtre non posé » : les envoyer comme
      // chaînes vides ferait échouer les schémas Zod du backend, qui attendent
      // soit une valeur soit rien.
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // Ni statut ni corps : le backend n'a pas répondu. C'est une panne de
      // déploiement, pas une erreur de l'appelant — 503 le dit, et l'agent
      // n'ira pas reformuler son filtre en croyant s'être trompé.
      throw new MassApiError(
        "L'API MASS est injoignable ou n'a pas répondu dans le délai imparti",
        503,
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    const text = await response.text();
    let envelope: ApiEnvelope<T> | null = null;
    if (text.length > 0) {
      try {
        envelope = JSON.parse(text) as ApiEnvelope<T>;
      } catch {
        envelope = null;
      }
    }

    if (!response.ok || envelope?.ok === false) {
      throw new MassApiError(
        envelope?.error || envelope?.message || `HTTP ${response.status}`,
        response.status,
        // Le corps brut n'est repris que s'il n'était pas du JSON : autrement
        // il ne dirait rien de plus que le message déjà extrait.
        envelope === null ? text.slice(0, 500) : undefined,
      );
    }

    if (envelope === null) {
      throw new MassApiError(
        "Réponse illisible de l'API MASS",
        response.status,
        text.slice(0, 500),
      );
    }

    return envelope.payload;
  }
}
