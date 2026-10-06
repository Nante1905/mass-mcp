# mass-mcp

Serveur MCP de la plateforme MASS, exposé en HTTP. Il donne à un agent
LangGraph les gestes du back-office : lire l'agenda et le fichier des adhérents,
analyser, préparer des brouillons, pointer des présences.

Il ne remplace pas le back-office et ne cherche pas à le faire. Ce qu'il ajoute,
c'est un chemin conversationnel vers des gestes qui existent déjà — et il
s'arrête là où ces gestes engagent quelqu'un.

## Ce que fait le serveur, et ce qu'il ne fait pas

**Il ne détient aucune identité.** Chaque appel porte le jeton de
l'administrateur connecté au back-office, que le serveur relaie au backend sans
le vérifier lui-même. C'est `mass-backend` qui tranche, en relisant le rôle en
base à chaque requête, exactement comme pour l'interface. Un administrateur
rétrogradé perd l'agent en même temps que le back-office ; un jeton expiré
cesse d'ouvrir quoi que ce soit sans que ce serveur ait rien à révoquer.

**Il ne publie pas.** `create_event_draft` force `status = draft` côté serveur,
et `update_draft` refuse tout évènement qui n'est plus un brouillon. Ce n'est
pas une consigne au modèle, c'est du code : la garantie tient même si l'outil
est appelé par autre chose que l'agent prévu.

**Il n'écrit pas sans qu'un humain ait relu.** `mark_attendance` appelé sans
`confirmed: true` n'écrit rien : il rend l'aperçu nominatif de ce qui
changerait, et le nombre de courriels que le pointage enverrait. C'est le
pendant serveur de l'`interrupt()` côté LangGraph — l'un présente, l'autre
refuse d'agir sans la trace de la présentation.

**Il ne réimplémente aucune règle métier.** Les écritures passent par l'API
REST : les schémas Zod, les transactions et les déclencheurs de la base
s'appliquent comme depuis le back-office. Seule `query_analytics` touche la base,
et seulement en lecture.

## Démarrage

```bash
npm install
cp .env.example .env      # puis renseigner MASS_API_URL
npm run dev               # http://localhost:4000/mcp
```

`mass-backend` doit tourner : sans lui, tous les outils sauf `query_analytics`
répondent 503.

Pour activer `query_analytics`, créer d'abord le rôle Postgres en lecture seule,
puis renseigner les cinq variables `ANALYTICS_DB_*` :

```bash
psql -h localhost -p 5432 -U postgres -d mass -f sql/readonly-role.sql
```

Sans ces variables le serveur démarre quand même : seule `query_analytics`
s'annonce indisponible, les sept autres outils restent utilisables.

## Les outils

| Outil | Passe par | Écrit |
|---|---|---|
| `list_events` | `GET /events` | non |
| `get_event_details` | `GET /events/:id` + `/participations` | non |
| `get_event_feedbacks` | `GET /events/:id` + `/feedbacks` + `/feedbacks/summary` | non |
| `list_members` | `GET /members` | non |
| `get_member_details` | `GET /members/:id` | non |
| `get_attendance_stats` | Postgres, rôle en lecture seule | non |
| `get_finance_summary` | `GET /transactions/stats` | non |
| `query_analytics` | Postgres, rôle en lecture seule | non |
| `generate_graph` | rien — met en forme les données reçues | non |
| `create_event_draft` | `POST /events` | brouillon |
| `update_draft` | `GET` puis `PUT /events/:id` | brouillon |
| `create_email_template` | `POST /communication/templates` | modèle, rien d'envoyé |
| `mark_attendance` | `PATCH /events/:id/participations/attendance` | après validation |
| `send_email` | `POST /communication/emails` ou `/groups/:id/emails` | après validation |

Les statuts sont exposés par leur nom — `draft`, `published`, `active`,
`present` — et non par les entiers de la base. Un modèle qui doit retenir que
`-5` veut dire « annulé » se trompe ; la traduction se fait une fois, dans
`src/tools/shared.ts`.

`update_draft` accepte un patch partiel alors que l'API attend l'évènement
entier : la lecture, la fusion et l'écriture se font dans l'outil. C'est ce qui
permet « déplace-le à 18h » sans que l'agent ait à reconstruire l'objet complet
— et donc sans qu'il puisse effacer un champ en l'oubliant.

`get_attendance_stats` ne passe pas par l'API : il n'y a pas de route pour lui,
et il n'en faut pas. Un taux de présence est une agrégation sur l'ensemble des
inscriptions — c'est le travail de la base, pas d'une pagination REST. Ses
requêtes sont écrites dans le fichier de l'outil, paramétrées, et ne passent
donc pas par le garde SQL, qui n'existe que pour ce qu'un modèle rédige.

`send_email` est la seule écriture de ce serveur qui sorte de l'association. Un
envoi groupé dont la composition ne peut pas être lue est **refusé** plutôt que
fait à l'aveugle : sans base de lecture, on validerait un identifiant de groupe,
pas des destinataires.

### Ce qui reste à faire

- `create_article_draft` — ni table ni module côté `mass-backend` : c'est le
  seul outil qui demande une migration.
- `get_observation_forecast` — attend son modèle astronomique.

## Sécurité de `query_analytics`

Trois barrières se superposent, chacune couvrant ce que la précédente laisse
passer :

1. **Le rôle Postgres** (`sql/readonly-role.sql`) n'a que `select`, et sur une
   liste fermée de tables. `users` est accordée colonne par colonne :
   `password` en est exclue. C'est la seule barrière qui tienne si les autres
   sont contournées.
2. **La transaction `begin read only`**, avec `statement_timeout` : une
   écriture est refusée par le moteur même si le rôle l'obtenait un jour, et une
   jointure malheureuse écrite par un modèle ne tient pas la base.
3. **Les contrôles de `src/analytics/sqlGuard.ts`** : une seule instruction,
   commençant par `select` ou `with`, sans mot-clé d'écriture, sans fonction
   système, sur les tables du catalogue. Ils analysent du texte — c'est la
   barrière la plus faible, et elle n'est pas là pour la sécurité mais pour que
   le refus arrive avant la base, avec une phrase qui dit quoi corriger.

S'y ajoute une protection structurelle : la requête est encapsulée dans
`select * from (…) as mcp_analytics limit N`. Une seconde instruction accrochée
à la première devient une erreur de syntaxe, pas une écriture.

Le catalogue des tables ouvertes est en double, dans `src/analytics/catalog.ts`
et dans le fichier SQL. Ajouter une table demande de le faire des deux côtés :
c'est voulu — l'oubli côté SQL refuse la lecture, l'oubli côté code aussi, et
aucun des deux n'ouvre quoi que ce soit par accident.

## Brancher un agent LangGraph

Le serveur est en mode sans session : chaque appel HTTP est indépendant, et
c'est ce qui permet à plusieurs administrateurs de l'utiliser en parallèle sans
qu'aucun état ne passe de l'un à l'autre.

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "mass": {
        "transport": "streamable_http",
        "url": "http://localhost:4000/mcp",
        # Le jeton de l'administrateur connecté au back-office, pas un secret
        # de service : c'est lui qui décide de ce que l'agent peut faire.
        "headers": {"Authorization": f"Bearer {admin_jwt}"},
    }
})
tools = await client.get_tools()
```

Le pointage se fait en deux temps, et le second n'a de sens que si le premier a
été montré à quelqu'un :

```python
# 1. Sans confirmed : rien n'est écrit, l'outil rend l'aperçu nominatif.
preview = await mark_attendance.ainvoke({
    "event_id": "EVT0012",
    "registration_ids": ["EMR0007", "EMR0008"],
})

# 2. interrupt() rend la main à l'humain, qui lit des noms — pas des clés.
approved = interrupt({"action": "mark_attendance", "preview": preview})

# 3. confirmed atteste de cette relecture. Jamais posé par le modèle seul.
if approved:
    await mark_attendance.ainvoke({..., "confirmed": True})
```

Un pointage envoie de vrais courriels : chaque personne nouvellement marquée
présente reçoit son lien d'avis. L'aperçu le dit et le compte, parce que c'est
la conséquence qu'un relecteur pressé oublierait.

## Vérifier à la main

```bash
curl http://localhost:4000/health

curl -X POST http://localhost:4000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Les réponses sont du JSON et non un flux d'évènements (`enableJsonResponse`) :
les outils ne diffusent rien en cours de route, et un `curl` suffit à lire ce
qui se passe.

## Structure

```
src/
  config.ts              configuration, validée au démarrage
  index.ts               écoute HTTP et arrêt propre
  http/server.ts         route /mcp, authentification, transport sans session
  mcp/createServer.ts    un serveur MCP par requête, avec ses instructions
  auth/adminContext.ts   extraction du jeton, contexte d'un appel
  clients/massApi.ts     client REST du backend, lié à un jeton
  analytics/
    catalog.ts           tables ouvertes, colonnes interdites, aide-mémoire du schéma
    sqlGuard.ts          contrôles avant la base, encapsulation du plafond
    readonlyPool.ts      pool dédié, transaction read only
  tools/                 un fichier par outil, plus shared.ts
sql/readonly-role.sql    le rôle Postgres qui porte la vraie garantie
```
