import Express, { json, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createToolContext, readBearerToken } from "../auth/adminContext.js";
import { config } from "../config.js";
import { isAnalyticsConfigured } from "../analytics/readonlyPool.js";
import { createMcpServer } from "../mcp/createServer.js";

/** Erreur JSON-RPC, seule forme qu'un client MCP sait lire sur `/mcp`. */
const rpcError = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

/**
 * Refus d'un appel sans jeton, ou dont le jeton n'ouvre rien.
 *
 * L'entête `WWW-Authenticate` est ce que la spécification d'autorisation MCP
 * attend : un client conforme y lit qu'il doit s'authentifier plutôt que de
 * conclure à une panne.
 */
const unauthorized = (res: Response, message: string): void => {
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer realm="mass-mcp"')
    .json(rpcError(-32001, message));
};

export const createHttpServer = () => {
  const app = Express();

  // 4 Mo : un appel MCP transporte du texte — une requête SQL, une description
  // d'évènement. La limite de 150 Mo du backend existe pour les bannières en
  // base64, que ce serveur n'accepte pas.
  app.use(json({ limit: "4mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      massApi: config.massApi.baseUrl,
      analytics: isAnalyticsConfigured() ? "configured" : "disabled",
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const token = readBearerToken(req);
    if (token === null) {
      unauthorized(
        res,
        "Authentification requise : joindre le jeton d'administrateur du back-office dans l'entête Authorization (Bearer …).",
      );
      return;
    }

    // Un serveur et un transport neufs à chaque appel : voir `createServer.ts`.
    // Le transport sans session (`sessionIdGenerator: undefined`) est ce qui
    // permet de tenir plusieurs administrateurs en parallèle sans qu'aucun état
    // ne survive d'une requête à l'autre.
    const server = createMcpServer(createToolContext(token));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Réponse JSON plutôt que flux d'évènements : les outils ne diffusent
      // rien en cours de route, et une réponse JSON se lit avec un `curl`.
      enableJsonResponse: true,
      ...(config.http.allowedOrigins.length > 0
        ? {
            enableDnsRebindingProtection: true,
            allowedOrigins: config.http.allowedOrigins,
          }
        : {}),
    });

    // Fermés ensemble, et à la fermeture de la réponse : sans cela, chaque
    // appel laisserait derrière lui un serveur et un transport vivants.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Échec du traitement d'un appel MCP", error);
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, "Erreur interne du serveur MCP"));
      }
    }
  });

  // Sans session, il n'y a ni flux à reprendre (`GET`) ni session à clore
  // (`DELETE`). Le dire par un 405 explicite évite qu'un client conclue à une
  // route absente et cherche ailleurs.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json(
        rpcError(
          -32000,
          "Ce serveur fonctionne sans session : seul POST /mcp est accepté.",
        ),
      );
  };

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
};
