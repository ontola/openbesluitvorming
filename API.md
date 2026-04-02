# Open Besluitvorming – Search API

This page documents the search API for Open Besluitvorming (Woozi), which indexes public Dutch government documents — council meetings, agendas, minutes, and attached documents — from municipalities (_gemeenten_), provinces (_provincies_), and water boards (_waterschappen_).

The search index is powered by [Quickwit](https://quickwit.io), a search engine with an HTTP API.

## Base URL

```
https://beta.openraadsinformatie.nl
```

The index ID is `woozi-events-prod`. All search requests go to:

```
POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search
```

The production domain is configured via the `DOMAIN` environment variable. The Quickwit search API is proxied at `/api/v1/` alongside the regular application routes.

> **Note:** The Quickwit API is read-only for external consumers. No authentication is required for search queries.

## Search request

Send a `POST` request with a JSON body:

```http
POST /api/v1/woozi-events-prod/search
Content-Type: application/json

{
  "query": "<quickwit query string>",
  "max_hits": 20,
  "start_offset": 0,
  "sort_by": "-start_date",
  "snippet_fields": ["content", "name"]
}
```

| Parameter        | Type    | Description                                                 |
| ---------------- | ------- | ----------------------------------------------------------- |
| `query`          | string  | Query string (see syntax below). Required.                  |
| `max_hits`       | integer | Maximum number of results to return. Default: 10, max: 100. |
| `start_offset`   | integer | Offset for pagination. Default: 0.                          |
| `sort_by`        | string  | Field to sort by. Prefix with `-` for descending order.     |
| `snippet_fields` | array   | Fields for which to return highlighted snippets.            |

## Query syntax

Quickwit uses a Lucene-like query syntax. The default search fields are `name`, `classification`, and `content`.

| Pattern                  | Example                                                     |
| ------------------------ | ----------------------------------------------------------- |
| Full-text search         | `begroting 2024`                                            |
| Exact phrase             | `"raadsvergadering begroting"`                              |
| Field filter             | `source_key:soest`                                          |
| Multiple filters (AND)   | `source_key:soest AND entity_type:Document`                 |
| OR                       | `entity_type:Meeting OR entity_type:Document`               |
| Date range               | `start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]` |
| Combine text and filters | `begroting AND source_key:amsterdam`                        |

## Document fields

Each indexed document has the following fields:

| Field              | Type     | Description                                                |
| ------------------ | -------- | ---------------------------------------------------------- |
| `entity_id`        | string   | Unique identifier for this entity                          |
| `entity_type`      | string   | `Meeting`, `Document`, or `DocumentPage`                   |
| `source_key`       | string   | Organization identifier (e.g. `soest`, `amsterdam`)        |
| `supplier`         | string   | Source system: `ibabs` or `notubiz`                        |
| `name`             | string   | Title of the meeting or document                           |
| `classification`   | string[] | Classification tags (e.g. `["Raadsvergadering"]`)          |
| `content`          | string   | Full-text content (agenda items, document text, page text) |
| `start_date`       | datetime | Meeting start time, or last discussed date for documents   |
| `end_date`         | datetime | Meeting end time (meetings only)                           |
| `organization`     | string   | Organization reference                                     |
| `committee`        | string   | Committee name (meetings only)                             |
| `file_name`        | string   | Original filename (documents only)                         |
| `page_number`      | integer  | Page number (DocumentPage only)                            |
| `parent_entity_id` | string   | Parent document ID (DocumentPage only)                     |
| `time`             | datetime | Timestamp when this event was indexed                      |
| `payload`          | object   | Compact entity payload with additional detail              |

### Entity types

- **`Meeting`** — a council or committee meeting, with agenda items and attached documents
- **`Document`** — a PDF or other file attached to meetings (agenda, minutes, report, etc.)
- **`DocumentPage`** — a single page of a multi-page document, for page-level full-text search. Links back to its parent via `parent_entity_id`.

## Organization keys (`source_key`)

Organization keys are lowercase slugs. Examples:

| Key               | Label           |
| ----------------- | --------------- |
| `soest`           | Soest           |
| `amsterdam`       | Amsterdam       |
| `haarlemmermeer`  | Haarlemmermeer  |
| `amsterdam_noord` | Amsterdam Noord |

The full list of indexed organizations is available via the web app source picker.

## Examples

### All documents from Soest from 2024

```bash
curl -X POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:Document AND source_key:soest AND start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]",
    "max_hits": 20,
    "sort_by": "-start_date"
  }'
```

### Search for "begroting" in all meetings

```bash
curl -X POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:Meeting AND begroting",
    "max_hits": 10,
    "snippet_fields": ["content", "name"]
  }'
```

### All meetings from Amsterdam in 2024

```bash
curl -X POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:Meeting AND source_key:amsterdam AND start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]",
    "max_hits": 50,
    "sort_by": "-start_date"
  }'
```

### Full-text search across all documents and meetings

```bash
curl -X POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "\"woningbouw\" AND (entity_type:Meeting OR entity_type:Document)",
    "max_hits": 20,
    "snippet_fields": ["content"]
  }'
```

### Page-level search inside documents

`DocumentPage` records let you find the exact page within a PDF that mentions a term. Use `parent_entity_id` to retrieve the full parent document.

```bash
curl -X POST https://beta.openraadsinformatie.nl/api/v1/woozi-events-prod/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:DocumentPage AND stikstof",
    "max_hits": 10,
    "snippet_fields": ["content"]
  }'
```

## Response format

```json
{
  "num_hits": 42,
  "hits": [
    {
      "entity_id": "...",
      "entity_type": "Document",
      "source_key": "soest",
      "name": "Raadsvoorstel begroting 2024",
      "start_date": "2024-11-07T00:00:00Z",
      "classification": ["Raadsvoorstel"],
      "file_name": "raadsvoorstel-begroting-2024.pdf",
      "payload": { ... }
    }
  ],
  "snippets": [
    {
      "content": ["...de <b>begroting</b> voor 2024 bedraagt..."]
    }
  ],
  "elapsed_time_micros": 12345,
  "errors": []
}
```

## Schemas

The canonical entity schemas are published as JSON Schema documents:

| Schema | Description |
|--------|-------------|
| [meeting.schema.json](/schemas/meeting.schema.json) | Council or committee meeting |
| [document.schema.json](/schemas/document.schema.json) | Attached document or media object |
| [committee.schema.json](/schemas/committee.schema.json) | Committee or organisation |
| [vote.schema.json](/schemas/vote.schema.json) | Vote record |
| [entity-commit.schema.json](/schemas/entity-commit.schema.json) | CloudEvents envelope wrapping the above |

These schemas define the structure of the `payload` field returned in search hits.

## Further reading

- [Quickwit search API reference](https://quickwit.io/docs/reference/rest-api)
- [Quickwit query language](https://quickwit.io/docs/reference/query-language)
