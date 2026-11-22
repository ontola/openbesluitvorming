# Reading ODS event polling feeds

Most sources are read through a supplier's own API: iBabs, Notubiz,
GemeenteOplossingen, Parlaeus. A source that offers a feed according to the
VNG standard [ODS Open Raadsinformatie, event polling 0.0.3](https://github.com/VNG-Realisatie/ODS-Open-Raadsinformatie/tree/feature/uitbreiden-dossiers/docs/event%20polling/versie%200.0.3)
is read through that feed instead, with the same code for every system that
implements it. OpenMeeting is the first.

```text
web container (every WOOZI_ODS_POLL_SECONDS)
  -> GET {feedUrl}/feed?cursor=<saved>&limit=1      news? queue an import
worker (the import)
  -> GET {feedUrl}/snapshot   (first time only, keeps feedCursor of page 1)
  -> GET {feedUrl}/feed?cursor=...   until hasMore is false
  -> mirror in object storage: ods/{source}/resources/, removed/, state.json
  -> OdsExtractor: Meeting, Committee and Document entities
  -> Quickwit + export log, like every other source
```

Only the worker moves the cursor. The poll in the web container reads it and
asks the feed for one record; it never applies anything.

## What we use from the spec

- `organisatiecode` is sent as a filter on every request, so one feed can
  serve several organisations.
- `upsert` replaces our copy of the resource. A record that is not newer than
  what we hold (`sequenceNumber`), or has the same `contentHash`, is skipped,
  so replaying a page is harmless.
- `delete` and `redact` are retracted at the next import: hidden from search,
  a tombstone in our own export feed, files removed from storage. A `redact`
  gets reason `takedown` in our feed, so it propagates as the spec asks of an
  aggregator. Nothing is blocklisted: an `upsert` later brings it back.
- A `400` on our cursor means it fell out of the feed's retention; we start
  again from the snapshot.
- `429` and `503` are retried after `Retry-After`.
- Resource types we do not read yet (`AanwezigeDeelnemer`) are skipped.

Mapping:

| ODS | Ours |
| --- | --- |
| `Vergadering` | `Meeting`: `naam`, `aanvang` (else `geplandeaanvang`, `vergaderdatum`, `geplandedatum`), `einde`, `locatie`, `vergadertoelichting`, `vergaderstatus` `geannuleerd` |
| `Vergadering.georganiseerddoorgremium` | `Committee` |
| `Agendapunt` | an agenda item of its `vergadering`, ordered by `volgnummer`; `hoofdagendapunt` is the parent, `indicatiehamerstuk` the classification |
| `Informatieobject` | `Document` on each of its `agendapunten`, or on its `vergaderingen`; `bestandsurl` is downloaded, without one the `omschrijving` is the text |

Ids are ours, derived from (`source`, type, `bronidentificatie`):
`meeting:ods:gemeente:eemdal:<bronidentificatie>`. A `bronidentificatie` that
is not a plain token (a URL, a `did:`) becomes a short stable hash.

## Configuring a source

```env
WOOZI_ODS_SOURCES=[{"key":"eemdal","label":"Eemdal","organizationType":"gemeente","organisatiecode":"gm9999","feedUrl":"https://eemdal.example/ori/v1"}]
```

- `feedUrl` is the base URL: the servicedocument is at `/`, the feed at
  `/feed`, the snapshot at `/snapshot`.
- `key` becomes part of every id and must not be the key of a catalog
  organisation. A municipality that moves to a feed changes its catalog entry
  instead.

Both containers read it; recreate both after changing it.

## What we refuse

Any `bestandsurl` that is not `https` on a public host name. The worker
downloads these from inside our network, so IP literals, single-label names,
`.internal` and `.localhost` are refused, and every redirect is checked again
before it is followed. Such a document is skipped with a warning on the run.
