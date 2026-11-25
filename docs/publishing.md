# Publishing from OpenMeeting

Most sources are polled: the worker asks iBabs, Notubiz, GemeenteOplossingen
or Parlaeus what changed. An OpenMeeting council publishes instead: its clerk
(griffie) sends a meeting when its agenda is set or changes, and we import it
through the same pipeline as everything else. For now that is the meeting, its
agenda and its openbare documents; recordings and motions follow.

```text
OpenMeeting (griffie: "Publiceren op OpenBesluitvorming")
  -> PUT /api/publish/{source}/meetings     (web container, bearer token)
  -> object storage: published/openmeeting/{source}/meetings/<hash>.json
  -> queued import of that meeting's day     (startIngest, trigger "api")
  -> worker: OpenMeetingExtractor reads the store
  -> Meeting, Committee and Document entities -> Quickwit + export log
```

The store is to a publishing source what the supplier API is to a polled one,
so the nightly window, a full import from the admin UI and the weekly coverage
check all work on it unchanged.

## Configuring a council

OpenMeeting councils are not in the ORI catalog (`src/sources/catalog.data.ts`).
Each deployment declares its own in `WOOZI_OPENMEETING_SOURCES`, a JSON array,
in both the web and the worker container:

```env
WOOZI_OPENMEETING_SOURCES=[{"key":"eemdal","label":"Eemdal","organizationType":"gemeente","cbsId":"GM9999","token":"<openssl rand -hex 32>"}]
```

- `key` becomes part of every id (`meeting:openmeeting:gemeente:eemdal:...`)
  and must not be the key of a catalog organisation: the catalog refuses
  duplicates. A municipality that moves its whole RIS to OpenMeeting changes
  its catalog entry instead.
- `token` (at least 24 characters) is what the clerk enters in OpenMeeting.
  It is compared in constant time and never appears in `/api/sources`.

Recreate both containers after changing it.

## The request

```http
PUT /api/publish/eemdal/meetings
Authorization: Bearer <token>
Content-Type: application/json

{ "id": "did:ad:...", "name": "Commissie Ruimte", "start_date": "2026-10-30T19:30:00Z", "agenda": [...] }
```

The body is OpenMeeting's ORI `Meeting` export (`lib/data/publish.dart`,
`publication()`); `tests/fixtures/openmeeting/commissie-ruimte.json` is a real
one and both repositories test against it. The answer is `202` with our
`meeting_id`, the day and the queued `run`. When an import of that day is
already queued or running, the meeting is still stored, `run` is `null` and
`note` says so; the nightly import (-7..+28 days) picks it up.

`GET ...?id=<their id>` returns what we hold. `DELETE ...?id=<their id>` stops
publishing it; what was already imported stays findable until it is withdrawn
with `scripts/delete_document.ts`, as for any other source.

## What we refuse

- Any `original_url` that is not `https` on a public host name. The worker
  downloads these from inside our network, so IP literals, single-label names,
  `.internal` and `.localhost` are refused on arrival, and every redirect is
  checked again before it is followed.
- Bodies over 2 MB, more than 500 agenda items or 200 documents per item.
- A wrong token and an unknown source answer the same `401`.

A document without a file may carry its text in `description`; it is stored as
the document's markdown and passes the same blocklist and BSN checks as an
extracted PDF.
