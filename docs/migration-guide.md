# Migreren van Open Raadsinformatie Classic naar OpenBesluitvorming

Gids voor hergebruikers van de Open Raadsinformatie API.

Status: concept, 2026-07-10.

## Voor wie is deze gids?

- Gebruikers van `https://api.openraadsinformatie.nl/v1/elastic/...` (de
  Elasticsearch proxy).
- Gebruikers van `fetch_documents.py` of eigen harvest-scripts.
- Gebruikers van document-resolve URLs onder
  `https://api.openraadsinformatie.nl/v1/resolve/...`.
- Bouwers van dashboards, monitors, notificaties en onderzoeksdatasets op
  raadsinformatie.

## Wat is er veranderd?

Open Raadsinformatie Classic was in de praktijk een publieke, read-only
Elasticsearch 7 proxy: je stuurde zelf Elastic Query DSL en kreeg ruwe
indexdocumenten terug. OpenBesluitvorming is een product-API met daarachter een
Quickwit-zoekprojectie. De belangrijkste verschillen:

1. **Geen vrije Elastic DSL meer.** Zoeken gaat via `GET /api/search`
   (aanbevolen) of via de ruwe Quickwit query language (geavanceerd).
2. **Andere entiteitsnamen.** Classic `MediaObject` heet nu `Document`.
   `Meeting` blijft `Meeting`. `AgendaItem` is geen los zoekresultaat meer maar
   onderdeel van de `agenda` in een Meeting-detail.
3. **Nieuwe, stabiele identifiers.** Classic gebruikte numerieke
   `@id`-waarden (bv. `131071`) die bij re-indexatie konden wijzigen. Nieuwe
   IDs zijn samengesteld, bv. `document:notubiz:gemeente:soest:12345`:
   deterministisch opgebouwd uit type, leverancier, organisatie en het ID bij
   de bron. Ze veranderen dus niet bij her-indexatie, zolang de bron zijn
   eigen ID niet wijzigt. Er is geen mapping tussen oude en nieuwe IDs; zie
   [Oude IDs en links](#recept-10-oude-ids-en-links).
4. **Documenttekst zit niet meer in elk zoekresultaat.** Zoekresultaten zijn
   compact (titel, snippet, downloadlink); volledige tekst haal je per entiteit
   op via `GET /api/entities/{id}`.
5. **Pagina-niveau zoeken.** Documenten zijn ook per pagina geïndexeerd
   (`DocumentPage`). `/api/search` groepeert paginahits terug naar
   documentniveau en geeft `matchedPage` mee.
6. **Eén index in plaats van honderden.** Classic had per organisatie indexen
   (`ori_amersfoort_*`). Nu is er één index met een `source_key`-veld per
   organisatie.
7. **Bulk export krijgt een eigen route.** Harvesten door de zoekindex leeg te
   pagineren wordt niet meer ondersteund; zie
   [Bulk harvesting](#recept-9-bulk-harvesting).

## Base URL

```text
https://openbesluitvorming.nl
```

(ook bereikbaar als `https://beta.openbesluitvorming.nl`)

Geen authenticatie; alle endpoints zijn read-only.

## Endpoint cheat sheet

| Classic | Nieuw aanbevolen | Opmerking |
| --- | --- | --- |
| `GET /v1/elastic/ori_*/_search?q=term` | `GET /api/search?query=term` | Simpel zoeken |
| `POST /v1/elastic/ori_*/_search` (Query DSL) | `GET /api/search?...` of `POST /api/v1/woozi-events-prod/search` | DSL wordt niet 1-op-1 ondersteund |
| `POST /v1/elastic/ori_amersfoort_*/_search` | `GET /api/search?organization=amersfoort` | `organization` = source key |
| `range` op `last_discussed_at` | `dateFrom`/`dateTo`, of raw Quickwit `start_date:[.. TO ..]` | Zie recept 3 voor het verschil |
| `terms` op `_id` (batch lookup) | Raw Quickwit `entity_id:("a" OR "b")` | Zie recept 7 |
| `_source.text` / `md_text` | `GET /api/entities/{id}` → `markdownText` | Detailtekst apart ophalen |
| `/v1/resolve/...` (document ophalen) | `downloadUrl` / `pdfUrl` uit detail response | Verwijst naar de bronleverancier |
| Elastic `highlight` | `summaryHtml` in `/api/search`, of Quickwit `snippet_fields` | Niet identiek aan Elastic highlights |
| `GET /_cat/indices?v` | `GET /api/sources` | Organisatie-discovery |
| `GET /ori_*/_mapping` | Veldtabel hieronder + `/schemas/*.schema.json` | Vast schema, geen mapping endpoint |
| `search_after` harvesting | `/api/export/snapshot` + `/api/export/changes` | Zie recept 9 |
| `https://id.openraadsinformatie.nl/{id}` (RDF) | Niet ondersteund | Zie recept 10 |

## Veldmapping

### Classic `MediaObject` → nieuw `Document`

| Classic veld | Nieuw | Waar |
| --- | --- | --- |
| `@id` | `entityId` (nieuw formaat) | search + detail |
| `@type: MediaObject` | `entityType: Document` | search + detail |
| `name` | `title` | search + detail |
| `file_name` | `file_name` | alleen raw Quickwit |
| `content_type` | `contentType` | detail |
| `size_in_bytes` | — niet beschikbaar | |
| `url` (Classic resolve/cache) | `downloadUrl`, `pdfUrl` | detail; verwijst naar bronleverancier |
| `original_url` | `downloadUrl` / `payload.original_url` | detail / raw Quickwit |
| `last_discussed_at` | `sortDate` (API) / `start_date` (Quickwit) | search + detail |
| `date_modified` | — niet beschikbaar (`time` in Quickwit is het indexeer-tijdstip, niet de bronwijziging) | |
| `is_referenced_by` | `meetingId` | detail |
| `text`, `md_text` | `markdownText` | detail |
| `text_pages` | `DocumentPage` entiteiten, `matchedPage`, `pageCount`, PDF page endpoint | search / raw / PDF endpoint |
| `has_organization_name` | `organization` (label) / `source_key` (key) | search / raw |
| index `ori_<gemeente>_*` | `source_key` | raw Quickwit; `organization`-parameter in `/api/search` |

### Classic `Meeting` → nieuw `Meeting`

| Classic veld | Nieuw | Waar |
| --- | --- | --- |
| `name` | `title` | search + detail |
| `classification` | `classification` | alleen raw Quickwit |
| `organization` | `organization` | search + detail |
| `committee` | `committee` | alleen raw Quickwit |
| `attachment` | `agenda[].documents[]` | detail |
| `start_date` | `sortDate` / `start_date` | search + detail |
| `status` | — niet beschikbaar | |

### Classic `AgendaItem`

`AgendaItem` is geen top-level zoekresultaat meer. Agenda-items zitten als
boomstructuur in de Meeting-detail response (`agenda[]`, met geneste
`agenda_items[]` en `documents[]`). Zoek op de vergadering of op het document,
niet op het agendapunt.

## Recepten

### Recept 1: Zoeken op term

Classic:

```http
POST https://api.openraadsinformatie.nl/v1/elastic/ori_*/_search
{ "query": { "simple_query_string": { "query": "begroting", "fields": ["text", "title", "name", "description"] } } }
```

Nieuw:

```bash
curl "https://openbesluitvorming.nl/api/search?query=begroting&limit=10"
```

De zoekterm wordt gematcht op titel, classificatie en documentinhoud. Het
antwoord bevat compacte resultaten met `summary`/`summaryHtml` (snippet),
`downloadUrl`, `matchedPage` en `previewImageUrl`. `totalCount` is een
benadering (`totalIsApproximate: true`) — reken er niet op zoals op Classic
`hits.total`.

Let op: `/api/search` vereist minimaal een `query` óf een `organization`;
zonder beide krijg je een leeg resultaat.

### Recept 2: Zoeken binnen één organisatie

Classic:

```text
POST /v1/elastic/ori_amersfoort_*/_search
```

Nieuw:

```bash
curl "https://openbesluitvorming.nl/api/search?query=begroting&organization=amersfoort"
```

De waarde van `organization` is de technische source key (kleine letters, geen
spaties). Haal de lijst met geldige keys op via:

```bash
curl "https://openbesluitvorming.nl/api/sources?implemented=true"
```

In raw Quickwit is het equivalent `source_key:amersfoort`.

### Recept 3: Filteren op datum

Classic:

```json
{ "range": { "last_discussed_at": { "gte": "2024-01-01", "lte": "2024-12-31" } } }
```

Nieuw, eenvoudig (voor interactieve/UI-toepassingen):

```bash
curl "https://openbesluitvorming.nl/api/search?query=begroting&dateFrom=2024-01-01&dateTo=2024-12-31"
```

**Belangrijk verschil met Classic:** bij een zoekterm evalueert `/api/search`
het datumfilter over een begrensde relevantie-window, niet over de volledige
index. Voor brede zoektermen met een datumfilter op een oudere periode kun je
dus resultaten missen. Heb je een volledig, exact datumbereik nodig, gebruik
dan raw Quickwit — daar is de range onderdeel van de query zelf:

```bash
curl -X POST "https://openbesluitvorming.nl/api/v1/woozi-events-prod/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_type:Document AND source_key:amersfoort AND start_date:[2024-01-01T00:00:00Z TO 2024-12-31T23:59:59Z]",
    "max_hits": 100,
    "sort_by": "-start_date"
  }'
```

### Recept 4: Alleen documenten of alleen vergaderingen

Classic:

```json
{ "term": { "@type": "MediaObject" } }
```

Nieuw:

```bash
curl "https://openbesluitvorming.nl/api/search?query=begroting&entityType=Document"
curl "https://openbesluitvorming.nl/api/search?query=begroting&entityType=Meeting"
```

Raw Quickwit: `entity_type:Document`, `entity_type:Meeting`,
`entity_type:DocumentPage`.

### Recept 5: Documentdetail en volledige tekst ophalen

Classic haalde je `_source.text` / `_source.md_text` direct uit de zoekhit, of
je downloadde het bestand via `/v1/resolve/...`.

Nieuw: neem het `entityId` uit een zoekresultaat en vraag de detail response
op. Let op: entity IDs bevatten dubbele punten en moeten URL-encoded worden
(`:` → `%3A`).

```bash
curl "https://openbesluitvorming.nl/api/entities/document%3Anotubiz%3Agemeente%3Asoest%3A12345"
```

Response bevat onder meer:

- `markdownText` — de volledige tekst als markdown (vervanger van `text` /
  `md_text`);
- `downloadUrl` — het originele bestand bij de bronleverancier (vervanger van
  `original_url`; er is geen gecachte kopie zoals Classic `/v1/resolve/`);
- `contentType`, `pdfUrl`;
- `meetingId` — de vergadering waar het document bij hoort (vervanger van
  `is_referenced_by`).

Voor een Meeting bevat de detail response de volledige `agenda` inclusief
documenten per agendapunt.

### Recept 6: Paginamatch en PDF-preview

Classic had `text_pages` als array in de source. Nieuw:

- `/api/search` geeft bij een paginamatch `matchedPage` en `pageCount` terug;
- render een pagina als afbeelding (JPEG):

```bash
curl -o page3.jpg "https://openbesluitvorming.nl/api/entities/document%3A...%3A12345/pdf/page/3"
```

De response header `X-Pdf-Page-Count` bevat het totale aantal pagina's.

- pagina-niveau zoeken kan ook direct via raw Quickwit:

```bash
curl -X POST "https://openbesluitvorming.nl/api/v1/woozi-events-prod/search" \
  -H "Content-Type: application/json" \
  -d '{ "query": "entity_type:DocumentPage AND stikstof", "max_hits": 10, "snippet_fields": ["content"] }'
```

Een `DocumentPage`-hit heeft `page_number` en verwijst via `parent_entity_id`
naar het document.

### Recept 7: Meerdere entiteiten op ID ophalen (batch)

Classic-patroon (veel gebruikt door scrapers die eerder gevonden IDs
verrijken):

```json
{ "size": 60, "query": { "terms": { "_id": ["123", "456"] } }, "_source": ["attachment"] }
```

Nieuw: er is (nog) geen batch-endpoint. Opties:

1. Per stuk via `GET /api/entities/{id}` (prima voor tientallen IDs).
2. Batch via raw Quickwit met een OR-query — quote de IDs altijd, ze bevatten
   dubbele punten:

```bash
curl -X POST "https://openbesluitvorming.nl/api/v1/woozi-events-prod/search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "entity_id:(\"document:notubiz:gemeente:soest:12345\" OR \"document:notubiz:gemeente:soest:12346\")",
    "max_hits": 100
  }'
```

### Recept 8: Discovery — welke organisaties en velden zijn er?

Classic: `GET /_cat/indices?v` en `GET /ori_*/_mapping`.

Nieuw:

```bash
curl "https://openbesluitvorming.nl/api/sources"
curl "https://openbesluitvorming.nl/api/stats"
```

`/api/sources` geeft per bron de `key` (voor filteren), het `label`, de
`supplier` (`notubiz`, `ibabs`, ...) en het `organizationType` (gemeente,
provincie, waterschap). Het veldenschema is vast en gedocumenteerd; de
canonieke entiteitsschema's staan op `/schemas/meeting.schema.json`,
`/schemas/document.schema.json`, enz.

### Recept 9: Bulk harvesting

Classic-patroon (`fetch_documents.py`): brede `_search` over `ori_*` met
`search_after`-paginering, vaak met volledige `_source`.

Dit patroon wordt **niet** overgenomen. De zoekindex is geen bulkdatabase:
diepe paginering over Quickwit is geen stabiel contract (sortering en
`search_after` gedragen zich anders dan in Elasticsearch), en volledige
documentteksten in bulkresponses waren de grootste kostenpost van Classic.

De vervanger is een expliciete exportroute volgens het snapshot +
changes-patroon. Stap 1, initiële sync — pagineer door de huidige stand en
onthoud de `X-Changes-Cursor` header van de eerste pagina:

```bash
curl -D - "https://openbesluitvorming.nl/api/export/snapshot?source=amersfoort&limit=500"
curl "https://openbesluitvorming.nl/api/export/snapshot?source=amersfoort&cursor=<X-Next-Cursor>"
```

Stap 2, bijblijven — poll de changes-feed met die cursor:

```bash
curl -D - "https://openbesluitvorming.nl/api/export/changes?source=amersfoort&cursor=<X-Changes-Cursor>"
```

Beide endpoints leveren NDJSON (één record per regel) met `X-Next-Cursor` en
`X-Has-More` headers. De changes-feed bevat álle wijzigingen — ook documenten
die later aan oude vergaderingen worden gehangen, correcties en
verwijderingen (`op: "delete"`) — dus periodiek her-harvesten is niet meer
nodig. Records zijn compact: volledige tekst haal je per document op via
`/api/entities/{id}`. Zie [API.md](/API.md#bulk-export) voor het volledige
recordformaat.

Let op: de exportlog wordt gevuld vanaf de eerstvolgende volledige import per
bron. Mis je een bron of periode in de snapshot, neem dan contact op.

Verder geldt:

- gebruik een User-Agent met projectnaam en contactadres;
- haal volledige tekst per document op via `/api/entities/{id}`, niet via
  brede zoekqueries.

### Recept 10: Oude IDs en links

- Oude numerieke Classic-IDs (`@id: "131071"`) bestaan niet in
  OpenBesluitvorming en zijn niet opzoekbaar.
- `https://id.openraadsinformatie.nl/{id}` RDF-resolving wordt niet
  ondersteund in de nieuwe API.
- Wil je een bestaande Classic-dataset koppelen aan nieuwe entiteiten, gebruik
  dan `original_url` als sleutel: die staat in Classic in `_source.original_url`
  en in de nieuwe data als `payload.original_url` (raw Quickwit) respectievelijk
  `downloadUrl` (detail response).

## Wat wordt bewust niet meer ondersteund

- Vrije Elasticsearch Query DSL, `_msearch`, scroll en `search_after` als
  publiek contract;
- onbegrensde responsegroottes en volledige documenttekst in zoekhits;
- `_source.includes`/`excludes`-achtige veldselectie op `/api/search`;
- schrijf-endpoints (die waren op Classic ook al geblokkeerd);
- JSON-LD/`@context` en RDF content negotiation.

## Limieten en verwachtingen

- `/api/search`: `limit` maximaal 100; paginering met `offset` is bedoeld voor
  het doorbladeren van de eerste pagina's, niet voor harvesting — bij een
  zoekterm wordt een begrensde window van ruwe hits bekeken.
- `totalCount` is approximatief.
- Raw Quickwit (`/api/v1/...`): alleen read-only paths zijn publiek. Dit is een
  power-user route: de velden volgen de interne zoekprojectie
  (`projection_version`) en kunnen bij projectiewijzigingen veranderen zonder
  de garanties van de publieke REST API.
- Voor bulk: gebruik de export endpoints (recept 9), niet de zoek-API.

## Vragen, wijzigingen en aankondigingen

- Breaking changes aan de publieke REST API worden vooraf aangekondigd;
  aanmelden voor aankondigingen kan via de contactroute hieronder.
- De raw Quickwit route volgt de interne zoekprojectie en valt buiten die
  garantie; het veld `projection_version` in de hits geeft aan met welke
  projectieversie je praat.
- De einddatum van de Classic API wordt ruim van tevoren aangekondigd, ook in
  de Classic API-responses zelf.
- Loop je bij het migreren ergens op vast, of heb je een bulk-use-case die de
  huidige endpoints niet dekken? Neem contact op met het
  OpenBesluitvorming-team. <!-- TODO: contactadres/kanaal invullen -->

## Overzicht: welk endpoint voor welk doel

| Doel | Endpoint |
| --- | --- |
| Zoeken (aanbevolen) | `GET /api/search` |
| Volledige tekst / detail | `GET /api/entities/{id}` |
| PDF-pagina als afbeelding | `GET /api/entities/{id}/pdf/page/{n}` |
| Organisatielijst | `GET /api/sources` |
| Indexstatistieken | `GET /api/stats` |
| Geavanceerde queries, exacte datumranges, batch-IDs, aggregaties | `POST /api/v1/woozi-events-prod/search` |
| Bulk export / synchronisatie | `GET /api/export/snapshot` + `GET /api/export/changes` |
