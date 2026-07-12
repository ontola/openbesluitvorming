# Open Besluitvorming – API

This page documents the API for Open Besluitvorming (Woozi), which indexes public Dutch government documents — council meetings, agendas, minutes, and attached documents — from municipalities (_gemeenten_), provinces (_provincies_), and water boards (_waterschappen_).

## Base URL

```
https://beta.openbesluitvorming.nl
```

## Endpoints overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | GET | Search meetings and documents (recommended) |
| `/api/stats` | GET | Index statistics (document count, organization count) |
| `/api/sources` | GET | List available data sources |
| `/api/entities/{entity_id}` | GET | Full entity detail (text, agenda, download URL) |
| `/api/entities/{entity_id}/pdf/page/{n}` | GET | Rendered PDF page as JPEG image |
| `/api/export/snapshot` | GET | Bulk export: current state per source (NDJSON) |
| `/api/export/changes` | GET | Bulk export: change feed per source (NDJSON) |
| `/api/v1/woozi-events-prod/search` | POST | Raw Quickwit search (advanced) |

No authentication is required. All endpoints are read-only.

---

## Search

### `GET /api/search`

The recommended search endpoint. Returns grouped, deduplicated results with document-level grouping of page hits.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query (required) |
| `organization` | string | Filter by source key (e.g. `soest`, `amsterdam`) |
| `entityType` | string | Filter by type: `Meeting` or `Document` |
| `sort` | string | Sort order: `date_desc` (default), `date_asc`, or `relevance` |
| `dateFrom` | string | Start date filter (ISO 8601, e.g. `2024-01-01`) |
| `dateTo` | string | End date filter |
| `offset` | integer | Pagination offset (default: 0) |
| `limit` | integer | Results per page (default: 24) |

**Example:**

```bash
curl "https://beta.openbesluitvorming.nl/api/search?query=begroting&organization=soest&sort=date_desc&limit=10"
```

**Response:**

```json
{
  "results": [
    {
      "entityId": "document:notubiz:gemeente:soest:12345",
      "entityType": "Document",
      "entityTypeLabel": "Document",
      "organization": "Soest",
      "date": "7 november 2024",
      "sortDate": "2024-11-07 00:00:00",
      "title": "Raadsvoorstel begroting 2024",
      "summary": "De begroting voor 2024 bedraagt...",
      "summaryHtml": "De <b>begroting</b> voor 2024 bedraagt...",
      "downloadUrl": "https://...",
      "matchedPage": 3,
      "pageCount": 12,
      "previewImageUrl": "/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345/pdf/page/3"
    }
  ],
  "totalCount": 42,
  "totalIsApproximate": true,
  "hasMore": true
}
```

---

## Index statistics

### `GET /api/stats`

Returns the total number of indexed documents and unique organizations.

**Response:**

```json
{
  "documentCount": 3045470,
  "organizationCount": 124
}
```

Cached for 1 hour.

---

## Sources

### `GET /api/sources`

Lists all configured data sources.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `implemented` | string | Set to `true` to only return active sources |

**Response:**

```json
{
  "sources": [
    {
      "key": "soest",
      "label": "Soest",
      "supplier": "notubiz",
      "organizationType": "gemeente",
      "implemented": true,
      "isAggregate": false
    }
  ]
}
```

---

## Entity detail

### `GET /api/entities/{entity_id}`

Returns the full content for a meeting or document.

> **Note:** `entity_id` values contain colons. URL-encode them: `document:notubiz:gemeente:soest:12345` → `document%3Anotubiz%3Agemeente%3Asoest%3A12345`.

**Example:**

```bash
curl "https://beta.openbesluitvorming.nl/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345"
```

**Response (document):**

```json
{
  "entityId": "document:notubiz:gemeente:soest:12345",
  "entityType": "Document",
  "entityTypeLabel": "Document",
  "title": "Raadsvoorstel begroting 2024",
  "organization": "Soest",
  "date": "7 november 2024",
  "sortDate": "2024-11-07 00:00:00",
  "markdownText": "# Raadsvoorstel begroting 2024\n\n...",
  "downloadUrl": "https://...",
  "contentType": "application/pdf",
  "pdfUrl": "https://...",
  "meetingId": "meeting:notubiz:gemeente:soest:830424"
}
```

**Response (meeting):**

```json
{
  "entityId": "meeting:notubiz:gemeente:soest:830424",
  "entityType": "Meeting",
  "entityTypeLabel": "Vergadering",
  "title": "Raadsvergadering 2024-11-07",
  "organization": "Soest",
  "date": "7 november 2024",
  "sortDate": "2024-11-07 20:00:00",
  "agenda": [
    {
      "id": "...",
      "title": "Opening",
      "number": "1",
      "documents": [
        {
          "id": "document:notubiz:gemeente:soest:12345",
          "name": "Raadsvoorstel begroting 2024",
          "original_url": "https://..."
        }
      ],
      "agenda_items": []
    }
  ]
}
```

---

## PDF page rendering

### `GET /api/entities/{entity_id}/pdf/page/{page_number}`

Returns a rendered page of a PDF document as a PNG image. Pages are rendered at 96 DPI and cached permanently.

**Response headers:**
- `Content-Type: image/png`
- `Cache-Control: public, max-age=31536000, immutable`
- `X-Pdf-Page-Count: 12` (total pages in the document)

**Example:**

```bash
curl -o page1.png "https://beta.openbesluitvorming.nl/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345/pdf/page/1"
```

---

## Bulk export

The export endpoints are the supported way to harvest or synchronize data in
bulk. Do not use the search endpoints for harvesting.

Synchronization works in two steps:

1. **Initial sync** — page through `/api/export/snapshot` for the current
   state of a source. Remember the `X-Changes-Cursor` header from the *first*
   page.
2. **Stay in sync** — periodically call `/api/export/changes` with that
   cursor. Each response header `X-Next-Cursor` is the cursor for the next
   call. This feed includes late mutations (e.g. a document attached to an old
   meeting), corrections, and deletions — there is no need to re-harvest.

Both endpoints return NDJSON (`application/x-ndjson`): one record per line.

### `GET /api/export/snapshot`

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | string | Source key (required, see `/api/sources`) |
| `cursor` | string | `X-Next-Cursor` from the previous page |
| `limit` | integer | Records per page (default 500, max 1000) |

**Response headers:** `X-Next-Cursor`, `X-Has-More`, `X-Changes-Cursor`
(cursor to start the changes feed from; take it from the first page).

### `GET /api/export/changes`

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | string | Source key (required, see `/api/sources`) |
| `cursor` | string | Position in the change log. Omit to start from the beginning. |
| `limit` | integer | Records per page (default 500, max 1000) |

**Response headers:** `X-Next-Cursor`, `X-Has-More`. An empty body with
`X-Has-More: false` means you are caught up; store the cursor and poll later.

### Record format

```json
{
  "seq": 42,
  "op": "upsert",
  "time": "2026-07-10T12:00:00.000Z",
  "entity_id": "document:notubiz:gemeente:soest:12345",
  "entity_type": "Document",
  "source_key": "soest",
  "supplier": "notubiz",
  "commit_id": "commit:document:notubiz:gemeente:soest:12345:abc123def456",
  "content_hash": "sha256:...",
  "schema_version": "v1alpha1",
  "payload": { "type": "Document", "name": "...", "original_url": "...", "derived_content": { "markdown_key": "..." }, "media_urls": [ ... ] }
}
```

- Records are compact by design: full document text is never inlined. Fetch
  markdown via `GET /api/entities/{entity_id}` or the object key in
  `payload.derived_content.markdown_key`.
- `op` is `"upsert"` or `"delete"`. A delete record (tombstone) has no
  `payload`; remove the entity from your copy.
- The feed is deduplicated on `content_hash`: re-indexing unchanged data adds
  no records, so polling stays cheap.
- `seq` is monotonic per source. Cursors are stable: the same cursor always
  resumes at the same position.

> **Note:** the export log is populated from ingests going forward. A source's
> history appears in the feed after its next full import; until then the
> snapshot may be empty or partial for that source.

---

## Raw Quickwit search (advanced)

For advanced queries, the Quickwit search API is proxied at `/api/v1/`. This gives direct access to Quickwit's query syntax, aggregations, and sorting.

### `POST /api/v1/woozi-events-prod/search`

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

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Query string (Lucene-like syntax). Required. |
| `max_hits` | integer | Maximum results. Default: 10, max: 100. |
| `start_offset` | integer | Pagination offset. Default: 0. |
| `sort_by` | string | Sort field. Prefix with `-` for descending. |
| `snippet_fields` | array | Fields for highlighted snippets. |

### Query syntax

Quickwit uses a Lucene-like query syntax. Default search fields are `name`, `classification`, and `content`.

| Pattern | Example |
|---------|---------|
| Full-text search | `begroting 2024` |
| Exact phrase | `"raadsvergadering begroting"` |
| Field filter | `source_key:soest` |
| Multiple filters (AND) | `source_key:soest AND entity_type:Document` |
| OR | `entity_type:Meeting OR entity_type:Document` |
| Date range | `start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]` |
| Combine text and filters | `begroting AND source_key:amsterdam` |

### Document fields

| Field | Type | Description |
|-------|------|-------------|
| `entity_id` | string | Unique identifier |
| `entity_type` | string | `Meeting`, `Document`, or `DocumentPage` |
| `source_key` | string | Organization identifier (e.g. `soest`) |
| `supplier` | string | Source system: `notubiz` or `ibabs` |
| `name` | string | Title |
| `classification` | string[] | Tags (e.g. `["Raadsvergadering"]`) |
| `content` | string | Full-text content |
| `start_date` | datetime | Meeting start or document date |
| `end_date` | datetime | Meeting end time |
| `organization` | string | Organization name |
| `committee` | string | Committee name (meetings only) |
| `file_name` | string | Original filename (documents only) |
| `page_number` | integer | Page number (DocumentPage only) |
| `parent_entity_id` | string | Parent document ID (DocumentPage only) |
| `document_month` | string | Year-month for date faceting (e.g. `2024-11`) |
| `time` | datetime | Indexing timestamp |
| `projection_version` | string | Schema version of the projection |
| `payload` | object | Compact entity payload |

### Entity types

- **`Meeting`** — a council or committee meeting, with agenda items and attached documents
- **`Document`** — a PDF or other file attached to meetings
- **`DocumentPage`** — a single page of a multi-page document, for page-level search. Links to parent via `parent_entity_id`

### Examples

**All documents from Soest in 2024:**

```bash
curl -X POST "https://beta.openbesluitvorming.nl/api/v1/woozi-events-prod/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:Document AND source_key:soest AND start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]",
    "max_hits": 20,
    "sort_by": "-start_date"
  }'
```

**Page-level search:**

```bash
curl -X POST "https://beta.openbesluitvorming.nl/api/v1/woozi-events-prod/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:DocumentPage AND stikstof",
    "max_hits": 10,
    "snippet_fields": ["content"]
  }'
```

### Response format

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

---

## Typical workflow

1. Search with `/api/search` to find relevant documents
2. Take the `entityId` from a result
3. Call `/api/entities/{entityId}` to retrieve the full text or meeting agenda
4. Use `meetingId` on a document to navigate to the parent meeting
5. Use `/api/entities/{entityId}/pdf/page/{n}` to render PDF pages

## Schemas

Canonical entity schemas are published as JSON Schema documents:

| Schema | Description |
|--------|-------------|
| [meeting.schema.json](/schemas/meeting.schema.json) | Council or committee meeting |
| [document.schema.json](/schemas/document.schema.json) | Attached document or media object |
| [committee.schema.json](/schemas/committee.schema.json) | Committee or organisation |
| [vote.schema.json](/schemas/vote.schema.json) | Vote record |
| [entity-commit.schema.json](/schemas/entity-commit.schema.json) | CloudEvents envelope |

These define the structure of the `payload` field in search hits.

## Further reading

- [Quickwit search API reference](https://quickwit.io/docs/reference/rest-api)
- [Quickwit query language](https://quickwit.io/docs/reference/query-language)
