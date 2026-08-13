# Open Besluitvorming – API

This page documents the API for Open Besluitvorming (Woozi), which indexes public Dutch government documents — council meetings, agendas, minutes, and attached documents — from municipalities (_gemeenten_), provinces (_provincies_), and water boards (_waterschappen_).

## Base URL

```
https://openbesluitvorming.nl
```

## Endpoints overview

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/search` | GET | Search meetings, documents, motions and spoken word (recommended) |
| `/api/stats` | GET | Index statistics (document count, organization count) |
| `/api/sources` | GET | List available data sources |
| `/api/entities/{entity_id}` | GET | Full entity detail (text, agenda, motions with votes, recordings with transcript, download URL) |
| `/api/entities/{entity_id}/pdf/page/{n}` | GET | Rendered PDF page as JPEG image |
| `/api/export/snapshot` | GET | Bulk export: current state per source (NDJSON) |
| `/api/export/changes` | GET | Bulk export: change feed per source (NDJSON) |

No authentication is required. All endpoints are read-only.

Looking for voting behaviour per party? See [Use case: voting data](#use-case-voting-data).
Looking for what was actually said in a debate? See [Use case: spoken word](#use-case-spoken-word).
Planning something that makes a lot of requests? See [Rate limits](#rate-limits).

---

## Rate limits

`/api/*` is rate limited per client at **60 units per minute**, refilling
continuously (a token bucket, not a fixed window — you do not have to wait for a
minute boundary).

Most requests cost **1 unit**. Two exceptions:

| Request | Cost |
|---------|------|
| `/api/search` with `limit=24` or lower (the default) | 1 unit |
| `/api/search` with a higher `limit` | 1 unit per 24 results, rounded up — so `limit=100` costs 5 |
| `/api/entities/{id}/pdf/page/{n}` | 1/8 unit — a long agenda's thumbnails should not drain your budget |

The charge is per *requested* page, so asking for the server-side maximum drains
the budget five times faster than paging through the same results at the default
size. Both are allowed; pick whichever suits you.

Every response carries the current state, so you can pace yourself without
guessing:

```
RateLimit-Limit: 60
RateLimit-Remaining: 43
RateLimit-Reset: 17
```

`RateLimit-Reset` is the number of seconds until the bucket is back at full
capacity.

Exceeding the limit returns **`429 Too Many Requests`** with a JSON body and a
`Retry-After` header giving the seconds until *your* next request would fit:

```json
{
  "error": "Te veel verzoeken. Probeer het over 3 seconde(n) opnieuw.",
  "limit_per_minute": 60,
  "retry_after_seconds": 3,
  "hint": "Zware verzoeken tellen zwaarder: een zoekopdracht kost 1 eenheid per 24 resultaten, dus limit=100 kost 5. …",
  "documentation": "https://openbesluitvorming.nl/#api"
}
```

Treat `429` as "slow down", not as an error: honour `Retry-After` and continue.

For bulk work, prefer the [export endpoints](#bulk-export) over paging through
`/api/search` — they are built to hand over a whole source in one stream and
cost one unit per call.

---

## Errors

Errors are JSON. A failing search returns `500` with a generic message and a
`request_id`:

```json
{
  "error": "Zoeken mislukt. Probeer het opnieuw of meld deze fout met het request ID.",
  "request_id": "3f9c1a2b"
}
```

Quote that id when reporting a problem — the full detail is in the server log
under the same id. The response deliberately does not carry it: an earlier
version returned the search engine's own message, which exposed the generated
query and internal identifiers while telling the caller nothing they could act
on.

### Punctuation in queries

`query` is free text, not a query language. Punctuation is stripped and the
remaining words are combined with AND, so `kosten/baten` finds documents
containing both words, and `14:30` finds both parts. There is no phrase search:
quoting a phrase has no special meaning.

A query consisting only of punctuation returns zero results rather than
everything.

---

## Search

### `GET /api/search`

The recommended search endpoint. Returns grouped, deduplicated results with document-level grouping of page hits.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query. Required **unless** `organization` is given — a source key on its own browses that source without a search term. |
| `organization` | string | Filter by source key (e.g. `soest`, `amsterdam`). Case-sensitive; an unknown key returns `400`. See [`/api/sources`](#sources). |
| `entityType` | string | Filter by type: `Meeting`, `Document`, `Motion` or `Recording` (spoken word; matches resolve to their meeting). Case-sensitive; any other value returns `400`. |
| `sort` | string | Sort order: `date_desc` (default), `date_asc`, or `relevance` |
| `dateFrom` | string | Start date filter (ISO 8601, e.g. `2024-01-01`) |
| `dateTo` | string | End date filter |
| `offset` | integer | Pagination offset (default: 0). Must be zero or greater. |
| `limit` | integer | Results per page (default: 24, minimum 1, values above 100 are capped at 100). |

Parameters that cannot be honoured are refused with `400` rather than ignored:
an unknown `entityType` used to drop the filter and quietly return everything,
which is harder to notice than an error.

**Example:**

```bash
curl "https://openbesluitvorming.nl/api/search?query=begroting&organization=soest&sort=date_desc&limit=10"
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

Returns the full content for one entity. A document answers with its text and
download URL, a meeting with its agenda plus the motions decided in it and the
recordings of it, a motion with its outcome and votes.

> **Note:** `entity_id` values contain colons. URL-encode them: `document:notubiz:gemeente:soest:12345` → `document%3Anotubiz%3Agemeente%3Asoest%3A12345`.

**Example:**

```bash
curl "https://openbesluitvorming.nl/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345"
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
  ],
  "motions": [
    {
      "id": "motion:notubiz:gemeente:soest:...",
      "name": "M1 Woningbouw Soesterberg",
      "result": "aangenomen",
      "tally": { "in_favour": 20, "against": 11 },
      "votes": [],
      "agenda_item": "agenda_item:notubiz:gemeente:soest:...",
      "attachment_id": "document:notubiz:gemeente:soest:...",
      "download_url": "https://..."
    }
  ],
  "recordings": [
    {
      "id": "recording:notubiz:gemeente:soest:...",
      "media_type": "video",
      "stream_url": "https://...m3u8",
      "duration_seconds": 12304,
      "transcript_kind": "asr",
      "chapters": [
        {
          "title": "1 Opening",
          "start_seconds": 14,
          "end_seconds": 166,
          "agenda_item": "agenda_item:notubiz:gemeente:soest:..."
        }
      ],
      "segments": [
        { "start_seconds": 0, "end_seconds": 119.2, "text": "Goedenavond allemaal…" }
      ]
    }
  ]
}
```

`motions` and `recordings` are present only on a `Meeting`, and only when the
source publishes them. See [voting data](#use-case-voting-data) and
[spoken word](#use-case-spoken-word) below for what to expect from each.

---

## PDF page rendering

### `GET /api/entities/{entity_id}/pdf/page/{page_number}`

Returns a rendered page of a PDF document as a JPEG image. Pages are rendered at 96 DPI and cached permanently.

**Response headers:**
- `Content-Type: image/jpeg`
- `Cache-Control: public, max-age=31536000, immutable`
- `X-Pdf-Page-Count: 12` (total pages in the document)

**Example:**

```bash
curl -o page1.jpg "https://openbesluitvorming.nl/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345/pdf/page/1"
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

---

## Use case: voting data

Moties and amendementen are published as `Motion` entities. Where the council
uses a digital voting module, each one carries the vote of every individual
member, with their party.

### Find motions

```bash
curl "https://openbesluitvorming.nl/api/search?query=woningbouw&entityType=Motion&limit=10"
```

Add `organization=<source key>` to scope to one municipality. Note that a
search **requires a `query`** — an empty query returns no results for any
entity type.

### Fetch one motion

```bash
curl "https://openbesluitvorming.nl/api/entities/motion%3Aibabs%3Agemeente%3Ahouten%3A493049d8-2b51-4a8f-a885-bcd48efc1a2f"
```

The response carries a `motion` object:

```json
{
  "entityId": "motion:ibabs:gemeente:houten:...",
  "entityType": "Motion",
  "entityTypeLabel": "Motie",
  "motion": {
    "name": "045-2022 M Essenkade verhogen duurzaamheid",
    "motion_type": "Moties",
    "status": "Motie aangenomen",
    "result": "aangenomen",
    "tally": { "in_favour": 20, "against": 11 },
    "votes": [
      {
        "option": "tegen",
        "voter": "person:ibabs:gemeente:houten:4fe947d1-...",
        "voter_name": "Kasius, S.",
        "group": "party:ibabs:gemeente:houten:a93295fa-...",
        "group_name": "Partij ITH"
      }
    ]
  },
  "meetingId": "meeting:ibabs:gemeente:houten:..."
}
```

`result` is normalised to `aangenomen`, `verworpen`, `ingetrokken`,
`aangehouden` or `overig`; `status` keeps the supplier's own wording.

### The text of a motion

A motion is a registry entry, not a file: its text lives in an attached
document. Both routes to it are in the response.

- Fetching **one motion** gives you `pdfUrl` and `downloadUrl` directly, and
  `pdfEntityId` — the document id to pass to
  [`/pdf/page/{n}`](#pdf-page-rendering) if you want rendered pages.
- The **`motions[]` array on a meeting** gives each entry an `attachment_id`
  and, where it resolves, a `download_url`.

Around 40% of motions have no attachment at all; those carry the outcome and
the votes but no text.

### Bulk: every motion of a source

For analysis, use the export feed rather than paging search. Entity ids sort
alphabetically, so `cursor=motion` jumps straight past the documents:

```bash
curl "https://openbesluitvorming.nl/api/export/snapshot?source=houten&cursor=motion&limit=200"
```

Each line is a record whose `payload` holds the same fields as above. Follow
`x-next-cursor` until `x-has-more` is `false`, then switch to
`/api/export/changes` with `x-changes-cursor` to stay in sync.

### What to expect

Measured across all 153 iBabs sitenames (2026-07-31), and against the first
imported sources:

- **67 of 142 municipalities publish per-member votes.** The rest publish the
  motion and its outcome but no breakdown.
- Within those, roughly **62% of motions in the vote-era carry vote records** —
  a withdrawn motion never reaches a vote, and unanimous ones are not always
  recorded. Of 200 Houten motions sampled from the live feed: 127 had a
  `result`, 116 had `votes`, 130 linked to a meeting.
- Coverage starts when the municipality adopted the module, between 2017 and
  2026 — check the oldest motion with `votes` per source rather than assuming.

### Limitations worth designing around

- **`option` is only `voor` or `tegen`.** Abstentions and absences are
  indistinguishable: a member who did not vote is simply absent from the array.
  Meeting attendee lists are empty in the public supplier API, so turnout
  cannot be reconstructed.
- **Use `votes[].group_name` for party, not `parties`.** The `parties` field is
  derived from the proposer strings and is empty for many sources; the vote
  records always carry the fractie.
- **Identifiers are per-municipality.** `person:` and `party:` ids are stable
  within a source but there is no national register link, and party names vary
  in spelling (`CDA`, `Fractie CDA`, `raadsleden cda`). Roughly 42% of distinct
  party names map to a national party; the remainder are local lists.
- **Notubiz sources have no per-member votes**, only the outcome and the
  submitting parties. A few publish a vote breakdown as free text in
  `vote_summary`, stored verbatim.
- **Not every motion links to a meeting.** `meetingId` is absent when the
  reference could not be resolved; `motion.agenda_item_hint` then holds the
  supplier's raw text.

## Use case: spoken word

Meetings are also published as `Recording` entities: the video or audio
registration, a chapter per agenda item, and — where the supplier runs speech
recognition — a transcript. This is what makes a debate searchable on what was
actually said rather than only on what was written down afterwards.

### Search what was said

```bash
curl "https://openbesluitvorming.nl/api/search?query=stikstof&entityType=Recording&limit=10"
```

Hits come back as the **meeting**, not the recording, with the spoken fragment
as `summary` / `summaryHtml`:

```json
{
  "entityId": "meeting:notubiz:gemeente:putten:1423776",
  "entityType": "Meeting",
  "organization": "Putten",
  "date": "25 juni 2026",
  "summaryHtml": "… voor ons als SGP is daarbij het <b>stikstof</b> plan van de voet"
}
```

The result carries no timestamp. To place a fragment in time, fetch the meeting
and find the matching entry in `recordings[].segments`, each of which has
`start_seconds` and `end_seconds`.

### Fetch a meeting's recordings

```bash
curl "https://openbesluitvorming.nl/api/entities/meeting%3Anotubiz%3Agemeente%3Amidden-groningen%3A1270344"
```

`recordings[]` holds, per registration:

| Field | Meaning |
|-------|---------|
| `media_type` | `video` or `audio` |
| `stream_url` | The seekable stream (HLS). Without it a player can only start at zero. |
| `player_url` | The supplier's own player page |
| `duration_seconds` | Length of the registration |
| `transcript_kind` | `asr` where the transcript is machine-generated |
| `chapters[]` | `title`, `start_seconds`, `end_seconds`, `agenda_item` — the timeline that ties the video to the agenda |
| `segments[]` | `start_seconds`, `end_seconds`, `text` — the transcript itself |

The media bytes are never stored or proxied: a two-day council meeting is
~10 GB. `stream_url` and `player_url` point at the supplier.

### What to expect

Measured against the live index (2026-08-10), sampling 400 of 3,781 recordings:

- **3,781 recordings across 112 sources.** Concentrated: Haarlem alone has 226.
- **~88% carry a transcript** (`transcript_kind: asr`), **~94% carry chapters**.
- **97% is video**, the rest audio-only.
- Transcripts are speech recognition, not minutes: no punctuation you can rely
  on, names are often mangled, and there is **no speaker attribution** —
  `speakers[]` was empty in all 400 sampled. Treat a segment as "this was said
  in this meeting at this moment", not as a quote attributable to a named
  member.
- The transcript is not in the search payload — it is ~30 KB per meeting — so
  only `/api/entities/{id}` returns `segments`, never `/api/search`.

## Schemas

Canonical entity schemas are published as JSON Schema documents:

| Schema | Description |
|--------|-------------|
| [meeting.schema.json](/schemas/meeting.schema.json) | Council or committee meeting |
| [document.schema.json](/schemas/document.schema.json) | Attached document or media object |
| [committee.schema.json](/schemas/committee.schema.json) | Committee or organisation |
| [motion.schema.json](/schemas/motion.schema.json) | Motie/amendement with outcome and vote breakdown |
| [recording.schema.json](/schemas/recording.schema.json) | Video/audio registration with chapters and transcript |
| [vote.schema.json](/schemas/vote.schema.json) | Vote record (shape reused inside `Motion.votes`) |
| [entity-commit.schema.json](/schemas/entity-commit.schema.json) | CloudEvents envelope |

These define the structure of entity detail responses.
