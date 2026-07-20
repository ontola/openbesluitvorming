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

These define the structure of entity detail responses.
