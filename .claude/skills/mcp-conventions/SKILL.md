---
name: mcp-conventions
description: Conventions d'architecture du serveur MCP mass-mcp — un fichier par outil exposant un `ToolRegistrar`, schéma Zod inline (et non éclaté en types/dto/schemas comme dans mass-backend), paramètres en snake_case traduits vers l'API en camelCase, statuts exposés par leur nom, erreurs rendues via `errorResult` plutôt que levées, et garanties d'écriture (brouillon forcé, confirmation en deux temps) écrites dans le code et jamais confiées au modèle. À charger avant de créer ou modifier un outil, un client, un garde-fou SQL ou le transport HTTP, et pour toute revue de code sur ce dépôt.
---

# Conventions du serveur MCP (mass-mcp)

Ce dépôt expose l'API MASS à un agent. Il n'a donc pas un lecteur mais deux :
le développeur qui maintient le code, et **le modèle qui lit les descriptions
d'outils au moment de choisir quoi appeler**. La plupart des règles ci-dessous
découlent de ce second lecteur.

À appliquer pour tout nouveau code, et à signaler en revue quand l'existant
s'en écarte.

## 1. Structure des fichiers

```
src/
  config.ts              configuration, validée au démarrage, exportée en un seul objet gelé
  index.ts               écoute HTTP, arrêt propre
  http/server.ts         route /mcp, authentification, transport
  mcp/createServer.ts    assemblage du serveur MCP et de ses instructions
  auth/adminContext.ts   lecture du jeton, construction du ToolContext
  clients/massApi.ts     client REST du backend
  analytics/             catalog.ts, sqlGuard.ts, readonlyPool.ts
  tools/                 un fichier par outil + shared.ts + index.ts
sql/                     le rôle Postgres en lecture seule
```

Règles :

- **Un fichier par outil**, nommé en `camelCase` d'après l'outil
  (`markAttendance.ts` pour `mark_attendance`). Jamais deux outils dans un
  fichier, jamais un outil éclaté en plusieurs.
- **`tools/index.ts` ne contient que la liste** `TOOL_REGISTRARS`. Ajouter un
  outil, c'est ajouter un fichier et une ligne — rien d'autre ne change.
- **`tools/shared.ts`** porte ce qui est commun à plusieurs outils : tables de
  statuts, `guarded`, `toToolError`, `paginationShape`. Un helper utilisé par
  un seul outil reste dans le fichier de cet outil.
- **`analytics/` sépare les trois responsabilités** : `catalog.ts` décrit ce qui
  est ouvert, `sqlGuard.ts` décide, `readonlyPool.ts` exécute. Le garde ne se
  connecte pas ; le pool ne valide pas. C'est ce qui rend le garde testable
  sans base.

### Pourquoi pas la structure de `mass-backend`

`backend-conventions` impose `types/` + `dto/` + `schemas/` + `constants/` en
fichiers distincts. **Cette règle ne se transpose pas ici, et c'est
intentionnel.**

Dans le backend, le schéma Zod, le DTO et le service ont des cycles de vie
séparés : le DTO sert à trois appelants, le schéma protège une frontière HTTP.
Ici, le schéma Zod **est** l'outil : c'est le contrat que lit le modèle, sa
description est du prompt, et il ne s'utilise nulle part ailleurs. Le test de
`structure` côté back-office — « si je modifie A, dois-je presque toujours
ouvrir B ? » — répond oui pour le schéma, la description et l'implémentation
d'un outil. Ils vivent donc dans le même fichier.

Ce qui reste séparé, c'est ce qui est réellement partagé : les tables de
statuts et les helpers dans `shared.ts`, le catalogue dans `analytics/`.

## 2. Anatomie d'un outil

Un fichier d'outil exporte **un `ToolRegistrar`** et rien d'autre :

```typescript
export const registerListEvents: ToolRegistrar = (server, { api }) => {
  server.registerTool(
    "list_events",
    {
      title: "Lister les évènements",
      description: [...].join(" "),
      inputSchema: { ... },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guarded(async () => {
        const page = await api.get<Paginated<EventRow>>("/events", { ... });
        return jsonResult({ ... });
      }),
  );
};
```

Règles :

- **Le contexte arrive à l'enregistrement, pas à l'appel.** Le serveur est
  construit par requête HTTP ([mcp/createServer.ts](../../../src/mcp/createServer.ts)) :
  l'outil se ferme sur le client de son propre appelant. Ne jamais introduire un
  registre global de jetons — un outil distrait se servirait de celui du voisin.
- **Tout le corps est enveloppé dans `guarded`.** Aucun `try/catch` local qui se
  contente de relancer, aucun `console.log` d'erreur. `guarded` traduit
  l'exception en résultat d'outil via `toToolError`.
- **Les types de réponse de l'API sont déclarés en tête du fichier de l'outil**
  (`type EventRow = { … }`), non exportés. Ils décrivent ce que cet outil lit,
  pas un contrat partagé. Deux outils qui lisent la même route déclarent chacun
  le sous-ensemble qui les concerne.
- **`annotations` est obligatoire** : `readOnlyHint` sur toute lecture,
  `destructiveHint` / `idempotentHint` sur toute écriture, `openWorldHint: false`
  partout (le périmètre est fermé).

## 3. Un outil est un geste métier, pas un endpoint

C'est la règle qui a le plus d'effet sur la qualité de l'agent.

- **Nommer par l'intention**, pas par la route. `mark_attendance`, pas
  `patch_participations_attendance`.
- **Un outil peut faire plusieurs appels HTTP** si c'est ce que le geste exige.
  [updateDraft.ts](../../../src/tools/updateDraft.ts) lit, fusionne puis écrit,
  parce que l'API attend l'évènement entier alors que l'agent ne connaît que ce
  qui change. Exposer la contrainte de l'API aurait fait effacer des champs par
  oubli.
- **Ne pas créer un outil par route.** Une route sans usage conversationnel
  n'a pas à devenir un outil : chaque outil consomme du contexte chez le modèle
  et rend le choix plus difficile pour tous les autres.
- **Les paramètres sont en `snake_case`**, les charges utiles envoyées à l'API
  en `camelCase`. La traduction se fait dans le fichier de l'outil, à l'appel —
  c'est la seule frontière où les deux conventions se croisent.

### Les descriptions sont du prompt, pas de la documentation

Elles sont lues par un modèle qui n'a ni le code ni la base sous les yeux.

- Dire **quand** utiliser l'outil et quand lui en préférer un autre :
  « rend une page : pour compter ou agréger, utiliser `query_analytics` ».
- Annoncer **les effets de bord**. `mark_attendance` déclenche l'envoi de vrais
  courriels : la description le dit, l'aperçu les compte. Un effet de bord non
  annoncé est un défaut, même si le code est juste.
- **`.describe()` sur chaque champ** dont le nom ne suffit pas, en disant ce que
  vaut l'absence de valeur (« sans filtre, les deux remontent »).
- Écrire en français, en phrases. La description est relue par des humains en
  revue autant que par le modèle.

### Les réponses sont un budget de contexte

- **Rendre ce qui sert à répondre, pas ce que l'API a renvoyé.** `list_events`
  écarte la description des évènements : sur vingt lignes elle pèse plus que
  tout le reste, et la fiche est à un appel de distance.
- **Jamais de base64 ni de binaire** dans une réponse d'outil. `get_event_details`
  rend `hasBanner: true`, pas la bannière.
- **Distinguer le total du rapporté.** Sans `reported` à côté de `total`, un
  agent conclut de vingt lignes que vingt personnes sont inscrites.
- **Signaler la troncature** explicitement, avec la conduite à tenir
  (« reformuler en agrégat » plutôt que « augmenter le plafond »).

### Les statuts s'exposent par leur nom

La base manipule des entiers espacés de 5. Un modèle qui doit retenir que `-5`
veut dire « annulé » se trompe régulièrement.

La traduction se fait **une fois**, dans
[tools/shared.ts](../../../src/tools/shared.ts) (`EVENT_STATUS_BY_NAME`,
`eventStatusName`, `ATTENDANCE_BY_NAME`…). Un outil n'écrit jamais `status: 5`
en dur ni ne compare à un entier nu.

### Pas de `z.coerce` dans un schéma d'outil

Les schémas du backend coercent parce qu'ils lisent une chaîne de requête où
tout est texte. Un appel MCP arrive en JSON typé : coercer masquerait un modèle
qui envoie `"vingt"` au lieu de `20`, et le laisserait recommencer.

## 4. Les erreurs se rendent, elles ne se lèvent pas

Une exception qui traverse le protocole sort de la boucle de l'agent. Un
`isError` lui revient et il peut corriger.

- Tout ce qui vient de l'appel passe par **`errorResult`** : identifiant
  inconnu, filtre incohérent, préconditions non remplies.
- **Le message dit quoi corriger.** « L'évènement EVT0012 est en statut
  "published" : seuls les brouillons sont modifiables par cet outil » vaut mieux
  que « opération refusée ».
- **Distinguer ce qui est corrigeable de ce qui ne l'est pas.** `toToolError`
  traite 401/403 à part et écrit « inutile de réessayer » — sans quoi l'agent
  rejoue le même appel en croyant à une erreur de paramètre.

## 5. Les garanties d'écriture sont dans le code

**Une instruction au modèle n'est pas une garantie.** Les `annotations` MCP sont
des indications, pas des contrôles. Toute règle qui compte doit tenir même si
l'outil est appelé par un autre client que l'agent prévu.

- **Le statut d'un brouillon est forcé à l'écriture**, jamais repris d'un
  paramètre. `create_event_draft` pose `status: draft` en dur : l'outil ne peut
  pas publier, quoi qu'on lui demande.
- **Les préconditions sont relues côté serveur.** `update_draft` relit le statut
  avant d'écrire plutôt que de faire confiance à ce que l'agent croit savoir.
- **Une écriture qui engage quelqu'un se fait en deux temps.** Sans
  `confirmed: true`, l'outil n'écrit rien et rend l'aperçu **nominatif** de ce
  qui changerait — on fait relire des noms, pas des identifiants. Le second
  appel atteste d'une relecture humaine.
- **Ne jamais ajouter un paramètre qui permettrait de contourner ces règles**
  (`status`, `force`, `skip_validation`). S'il faut publier, c'est un geste de
  back-office.

## 6. Sécurité : trois principes non négociables

- **Aucune identité durable.** Le serveur ne détient ni compte de service ni
  secret d'administration : il relaie le jeton de l'appelant et laisse le
  backend trancher, qui relit le rôle en base à chaque requête. Ne jamais
  introduire de jeton de repli, même « pour les lectures ».
- **Un serveur MCP par requête HTTP**, transport sans session. C'est ce qui
  rend la propagation du jeton sûre.
- **Ce qui protège la base, ce sont les droits Postgres.** Les contrôles de
  [sqlGuard.ts](../../../src/analytics/sqlGuard.ts) analysent du texte : ils
  sont là pour que le refus arrive avant la base avec une phrase utile, pas
  pour tenir seuls. Toute table ajoutée à `ANALYTICS_TABLES` doit l'être aussi
  dans [sql/readonly-role.sql](../../../sql/readonly-role.sql) — le doublon est
  voulu, et un oubli d'un côté ou de l'autre ferme plutôt qu'il n'ouvre.

## 7. SOLID, tel qu'il s'applique ici

- **Responsabilité unique** — `sqlGuard` décide, `readonlyPool` exécute,
  `catalog` décrit. Un garde qui ouvrirait sa propre connexion ne serait plus
  vérifiable sans base.
- **Ouvert/fermé** — ajouter un outil n'impose de toucher aucun outil existant :
  un fichier, une ligne dans `TOOL_REGISTRARS`. Si un ajout oblige à modifier
  `createServer.ts` ou `http/server.ts`, c'est le signe qu'une abstraction
  manque.
- **Substitution** — tous les registrars ont la même signature et sont
  interchangeables dans la liste. Un outil qui aurait besoin d'un traitement
  particulier à l'enregistrement doit le porter lui-même.
- **Ségrégation des interfaces** — `ToolContext` n'expose que ce dont les outils
  ont besoin. Ne pas y ajouter un champ pour un seul outil : `query_analytics`
  importe son pool directement plutôt que de faire porter à tous les autres une
  dépendance à la base.
- **Inversion des dépendances** — les outils dépendent de `MassApiClient`, pas
  de `fetch`. Un outil qui appellerait `fetch` en direct perdrait la gestion du
  délai, de l'enveloppe `ApiResponse` et des erreurs.

## 8. Commentaires

La famille MASS commente en français, en phrases, et **explique le pourquoi** —
pas ce que le code fait déjà lire. Ce dépôt suit la même règle.

- Commenter les décisions : pourquoi un serveur par requête, pourquoi le
  plafond est posé à l'extérieur de la requête, pourquoi le catalogue est en
  double. Ce sont les endroits où un lecteur futur serait tenté de « simplifier ».
- Commenter ce qui protège quelque chose, en disant contre quoi.
- Ne pas commenter les évidences (`// incrémente i`).

## Checklist de revue

- [ ] Un fichier par outil, exportant un seul `ToolRegistrar` nommé `register<Outil>`.
- [ ] Ajouté à `TOOL_REGISTRARS` ; rien d'autre modifié ailleurs.
- [ ] Corps entièrement dans `guarded` ; aucun `try/catch` qui relance, aucun `console.log`.
- [ ] `annotations` renseignées (`readOnlyHint` ou `destructiveHint`/`idempotentHint`, `openWorldHint: false`).
- [ ] Description qui dit **quand** utiliser l'outil, ce qu'il ne fait pas, et **ses effets de bord**.
- [ ] `.describe()` sur chaque champ non évident, précisant ce que vaut l'absence de valeur.
- [ ] Paramètres en `snake_case` ; traduction vers `camelCase` faite dans l'outil.
- [ ] Aucun `z.coerce` ; aucun entier de statut en dur — passer par `shared.ts`.
- [ ] Réponse limitée à ce qui sert ; `total` et `reported` distingués ; troncature signalée.
- [ ] Aucune donnée binaire ni base64 dans une réponse.
- [ ] Erreurs rendues par `errorResult`, avec le geste correctif ; 401/403 traités à part.
- [ ] Pour une écriture : préconditions relues côté serveur, statut forcé, aucun paramètre de contournement.
- [ ] Pour une écriture qui engage quelqu'un : aperçu nominatif sans `confirmed`, et effets de bord comptés.
- [ ] Aucun jeton ni secret d'administration introduit dans la configuration.
- [ ] Table ajoutée à l'analyse : présente dans `catalog.ts` **et** dans `sql/readonly-role.sql`.
- [ ] Commentaires en français qui expliquent le pourquoi des décisions.
