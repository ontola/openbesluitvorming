# Importplan: video, audio en gesproken tekst

Vervolg op [video-import-research.md](video-import-research.md), waarin per
leverancier is uitgezocht wat er te halen valt. Dit plan beslaat **Notubiz en
iBabs**: die twee hebben publiek beschikbare transcripts en dekken samen 294 van
onze 330 bronnen. GO en Parlaeus staan onderaan als expliciet uitgesteld.

## Uitgangspunten

1. **Wij slaan geen videobytes op.** Eén Amsterdamse tweedaagse raadsvergadering
   is 9,8 GB; een gemiddelde raadsvergadering 200–400 MB. We bewaren URL's,
   duur, formaat en de afgeleide tekst. De bezoeker kijkt bij de bron, met een
   offset in de URL.
2. **De tekst is het product.** Een transcript is ~30 KB. Dat is wat
   openbesluitvorming.nl uniek maakt: doorzoekbaar maken wat er *gezegd* is,
   niet alleen wat er is opgeschreven.
3. **Eén nieuw entiteitstype, geen tweede vocabulaire.** We volgen het patroon
   van `Motion`: schema, canonical id, projectie, en een `parent_entity_id` naar
   de vergadering.
4. **Media zijn optioneel bijproduct van een run, nooit fataal.** Zoals bij
   moties: een leverancier die geen media publiceert is een normale uitkomst.

## 1. Entiteitsmodel: `Recording`

Nieuw type naast `Meeting`, `Document` en `Motion`. Eén `Recording` per
mediabestand per vergadering (Notubiz levert er meestal één, iBabs kan meerdere
webcasts per vergaderdag hebben).

Nieuw bestand `schemas/recording.schema.json`, `RecordingEntity` in
`src/types.ts`, en `canonicalRecordingId` + `"recording"` in `ScopedEntityType`
in `src/ids.ts`.

```ts
export interface RecordingEntity {
  id: string;                      // recording:notubiz:gemeente:haarlem:397530
  type: "Recording";
  name: string;                    // vergadertitel + datum
  classification?: string[];       // ["Video"] of ["Audio"]
  media_type: "video" | "audio";
  meeting?: string;                // canonical meeting id -> parent_entity_id
  start_date?: string;             // begin van de opname
  duration_seconds?: number;
  platform: "notubiz" | "companywebcast";
  player_url?: string;             // waar de bezoeker gaat kijken
  media_url?: string;              // directe mp4/mp3, niet gedownload
  content_type?: string;
  size_in_bytes?: number;
  transcript_language?: string;    // "nl", "fy", …
  transcript_kind?: "asr" | "corrected";
  segments?: RecordingSegment[];   // alleen in-memory; naar S3, niet naar payload
  chapters?: RecordingChapter[];   // agendapunt -> offset
  speakers?: RecordingSpeaker[];   // spreker -> offset
  derived_content?: {
    transcript_key?: string;       // S3-sleutel
    segment_count?: number;
    speaker_count?: number;
    chapter_count?: number;
  };
  organization?: string;
  source_info: SourceInfo;
  raw: unknown;
}

export interface RecordingSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
  speaker?: string;                // canonical person id waar bekend
}

export interface RecordingChapter {
  start_seconds: number;
  end_seconds?: number;
  title: string;
  agenda_item?: string;            // canonical agenda_item id
}

export interface RecordingSpeaker {
  start_seconds: number;
  end_seconds?: number;
  name: string;
  person?: string;
  party?: string;
}
```

`segments` gaat **niet** in de commit-payload en niet in `compactEntityPayload`.
Dezelfde afweging als bij `md_text`/`page_chunks`: de payload wordt per
Quickwit-hit opgeslagen, dus een transcript van 30 KB daarin zetten vermenigvuldigt
zich met het aantal hits.

## 2. Opslag

Transcript naar object storage, precies zoals afgeleide markdown, met dezelfde
versiesleutel zodat `reindex_only` er later bij kan:

```
recordings/<supplier>/<organization_type>/<source>/<canonical_id>/<derivation_version>/transcript.json
```

Inhoud: `{ segments: [...], chapters: [...], speakers: [...] }` — het volledige
tijdlijnmodel in één object, want de detailweergave heeft ze samen nodig.

Ruwe SRT/VTT bewaren we ernaast als `.srt` / `.vtt` onder dezelfde prefix, om
dezelfde reden dat we originele PDF's bewaren: als onze parser later beter wordt
willen we niet opnieuw bij de leverancier langs.

Schatting: ~257.000 Notubiz-transcripts × ~30 KB ≈ **7,7 GB**. Verwaarloosbaar
naast de huidige documentcache.

## 3. Projectie naar Quickwit — twee fasen, bewust

De index bevat vandaag (rijen in `woozi-events-prod`, inclusief oudere
projectieversies):

| entity_type | rijen |
| --- | --- |
| Document | 15.920.881 |
| DocumentPage | 40.132.730 |
| Meeting | 1.205.280 |
| Motion | 43.948 |

**Fase A — één rij per opname.** `entity_type: "Recording"`,
`parent_entity_id` = de vergadering (zoals `Motion` al doet), `content` = de
volledige transcripttekst, `start_date` via `toIndexDateTime` uit de
opnamedatum. Kosten: **~295.000 nieuwe rijen**, ongeveer 0,5% indexgroei.
Zoeken op gesproken tekst werkt daarmee direct; de sprong naar het juiste moment
in de video wordt bij het openen van het detail opgelost door het transcript uit
S3 te halen en de zoekterm daarin te lokaliseren.

**Fase B — segment-subdocumenten, alleen als fase A tekortschiet.**
`entity_type: "RecordingSegment"`, `entity_id` = `<recording_id>#t=<start>`,
exact het `DocumentPage`-patroon uit `projectDocumentPageDocuments`. Bij blokken
van ±2 minuten is dat ~90 rijen voor een vergadering van drie uur, ofwel
**~23 miljoen rijen** — een indexgroei van ongeveer 40%. Dat is geen bijzaak, en
gezien de bekende zoeklatentie (zie `docs/search-performance-quickwit-s3.md`)
verdient het een eigen meting.

De reden dat dit netjes gefaseerd kan: `transcript_key` staat in het
entiteitsobject, dus fase B is een **projectiewijziging**. `reindex_only`
rehydrateert al documenttekst uit object storage; hetzelfde mechanisme haalt
straks het transcript op. Geen tweede ronde langs Notubiz.

Verplicht bij beide fasen: `start_date` door `toIndexDateTime` halen. Een
mapped `datetime` die niet parset laat Quickwit het hele document weggooien met
een succesvol ogende ingest-respons.

## 4. Notubiz-slice

### Client (`src/notubiz/client.ts`)

Twee methodes erbij, beide met `AbortSignal.timeout`, via de bestaande
`fetchJson`/`fetchBytes`:

```ts
async listMedia(meetingId: number): Promise<NotubizMedia[]>   // GET /media?event_id=
async downloadSubtitles(media: NotubizMedia): Promise<string> // GET subtitles_url
```

`download_url` en `subtitles_url` komen **zonder schema** terug (`api.notubiz.nl/…`);
er moet `https://` voor. Ze bevatten spaties in `file=`, dus door
`encodeURI` halen.

### Extractor (`src/notubiz/extractor.ts`)

In de bestaande meetinglus, na `normalizeNotubizMeeting`: per vergadering
`listMedia`, en per mediabestand een `Recording` emitteren via `options.onEntity`.

Drie bronnen van tijdlijndata komen samen:

1. **Hoofdstukken** — `agenda_items[].start_offset` / `end_offset` zitten **al**
   in de meeting-detailrespons die we vandaag ophalen en weggooien. Nul extra
   calls.
2. **Transcript** — de SRT ophalen en parsen naar segmenten. Cues zijn 2–4
   seconden; die voegen we samen tot blokken van ±2 minuten, met een grens op
   een sprekerwissel waar we die kennen.
3. **Sprekers** — alleen in de portal-HTML (`meeting.url`), als
   `data-speaker_id` + `data-start_offset` + `data-end_offset`. `speaker_id`
   resolvet via `GET /organisations/<org>/speakers` naar naam, partij en functie;
   die lijst één keer per run ophalen en cachen.

Sprekers zijn de enige stap die scrapet in plaats van een API gebruikt, en de
portals zitten achter Cloudflare — bij een reeks snelle requests kwam er 403.
Daarom: sprekersfragmenten zijn **best effort**, met een eigen lage
concurrency, en een mislukking is een `warning`-issue en niet meer dan dat. Een
opname zonder sprekers is nog steeds volledig doorzoekbaar.

### Kosten en dekking

Gemeten over 25 bronnen, 2026-03-01 t/m 2026-05-31: 459 vergaderingen, 215 met
media (47%), waarvan 187 met SRT (87%).

De `live`-vlag in de events-lijst — die we al binnenkrijgen — voorspelt media
opvallend goed:

| | media aanwezig | geen media |
| --- | --- | --- |
| `live: true` | 52 | 1 |
| `live: false` | 2 | 72 |

Dus: `live: false` overslaan bespaart ~58% van de media-calls en kost ~3,6% van
de opnames. **Advies:** in normale runs gewoon iedere vergadering bevragen (het
is één kleine JSON-call), maar de eerste historische backfill sorteren op
`live: true` en de rest in een tweede veegronde meenemen.

## 5. iBabs-slice — via Company Webcast

### Stap 1: `Webcast.Code` uitlezen (nul extra iBabs-calls)

`parseMeetingsXml` in `src/ibabs/client.ts` leest vandaag elf velden uit
`iBabsMeeting` en laat `Webcast` liggen. Eén regel erbij:

```ts
WebcastCode: textValue(valueForLocalName(meeting, "Webcast"), "Code"),
```

Het veld zit al in de respons die we per meeting-run binnenhalen. Dit is
meteen de meting die nu ontbreekt: **hoeveel van onze 442.682 iBabs-vergaderingen
hebben een webcast, en welke sitenames gebruiken iets anders dan Company
Webcast?** Dat weten we pas als deze regel een keer over de backfill heen is
gelopen.

### Stap 2: Company Webcast-client (`src/companywebcast/client.ts`)

Nieuwe map, want dit is een eigen leverancier en geen iBabs-API. Vier calls, alle
vier zonder inloggen:

```
GET  sdk.companywebcast.com/players/<code met _>/info
GET  sdk.companywebcast.com/accessrules/<guid>/token          -> identificationToken
GET  sdk.companywebcast.com/accessrules/<guid>                -> Policy/Signature/Key-Pair-Id
                                                                 (header x-authorization)
GET  sdk.companywebcast.com/players/<guid>/vtt/               -> lijst sporen
GET  sdk.companywebcast.com/players/<guid>/vtt/public/<track> -> WEBVTT
GET  sdk.companywebcast.com/players/<guid>/ondemand/<x>@rootwrite/resources
GET  sdk.companywebcast.com/players/<guid>/ondemand/<x>@rootwrite/events/hls/0
```

De signature is ongeveer een jaar geldig, dus per opname één tokenpaar en dat
hergebruiken voor de rest van de calls van die opname.

`resources` levert `topic`- en `speaker`-objecten, `events/hls/0` de tijdlijn met
`index.index:activate` en `speakers.speaker:activate` op milliseconden. Die twee
samen geven hoofdstukken én sprekerssegmenten — rijker dan wat Notubiz publiek
geeft.

### Stap 3: koppeling aan onze vergadering

Primair via `Webcast.Code`: één op één, geen giswerk.

De CWC-`topic`-objecten dragen een `reference`-GUID die eruitziet als een
iBabs-`MeetingItem.Id`. Als dat klopt, koppelen hoofdstukken direct aan onze
agendapunten. **Dat is nog niet geverifieerd** — het kon niet, omdat iBabs ons
IP op het moment van onderzoek hard throttelde. Eerste stap na deployment van
stap 1: één meeting met webcast ophalen en de GUID's vergelijken. Valt het
tegen, dan koppelen we hoofdstukken op volgorde plus titelgelijkenis, wat een
zwakkere maar werkbare fallback is.

### Stap 4: de backfill hoeft niet op iBabs te wachten

`GET channel.royalcast.com/portal/api/1.0/<klant>/portalwebcasts/?currentPage=N&status=onDemand&ordering=startDesc&pageSize=30`
somt het volledige archief per gemeente op. Voor de 63 sitenames die
CWC-klant zijn onder hun eigen naam kunnen we het hele archief inlezen **zonder
één iBabs-call**, en achteraf koppelen op sitename + datum. Gegeven dat iBabs ons
routinematig throttelt tijdens de backfill (`breaker open for 900s`) is dat geen
detail maar het verschil tussen "kan nu" en "wacht op de wachtrij".

Gemeten over die 63: 52 leverden een bereikbare afgelopen uitzending, 42 met
VTT-transcript, 46 met mp4-download. Elf gaven HTTP 400 op `portalwebcasts`
terwijl het klantobject wél bestaat — apart uitzoeken, geen blokker.

## 6. Nieuwe executiemodus `media_only`

Toevoegen aan `IngestExecutionMode` in `src/types.ts`, naast `motions_only` en om
dezelfde reden: de historie opnieuw in `full` doorlopen betekent documenten
opnieuw downloaden die we al hebben.

- **Notubiz:** werkt. Alleen de events-lijst is nodig om meeting-id's te krijgen,
  daarna `/media` per vergadering. Geen documentpass.
- **iBabs:** werkt, in twee smaken — via `GetMeetingsByDateRange` voor
  `Webcast.Code`, of volledig via de CWC-kanaal-API zonder iBabs.
- **GO en Parlaeus:** gooien een duidelijke fout, zoals `motions_only` dat nu
  voor Notubiz doet.

Verder mee te nemen, in navolging van `motion_count`:

- `recording_count` op `IngestRunRecord`, optioneel, zodat oude runs geen valse
  nul rapporteren
- `recording_count` in `ExtractionStats` en in de `onProgress`/`onIssue`-payloads
- een teller in de admin-UI, want een stil mislukkende mediapass moet zichtbaar
  zijn (dat was de les van commit 1698755)

## 7. Zoek- en API-oppervlak

- `web/search_api.ts`: `Recording` toevoegen aan de `entityType`-filter en aan de
  gecombineerde query op regel ~210. Label "Opname".
- Meetingdetail: opnames ophalen via `parent_entity_id`, precies zoals
  `getMeetingMotions` dat doet.
- Detailweergave: speler met deeplink naar `?t=<seconden>`, hoofdstukkenlijst,
  sprekerslijst, en het transcript met de zoekterm gemarkeerd — het bestaande
  full-screen overlay-patroon.
- `API.md`: `Recording` bij de `entityType`-tabel, een voorbeeldrespons, en een
  sectie zoals die voor moties bestaat.
- `schemas/README.md` en `docs/migration-guide.md`: ORI Classic kende geen
  opnames, dus dit is puur nieuw en breekt niets.

## 8. Volgorde van uitvoering

1. Schema, type, id-helper, projectie fase A, `media_only`, `recording_count`.
   Nog geen leverancierscode. Te testen met een fixture.
2. Notubiz-slice compleet (media + SRT + hoofdstukken), zonder sprekers. Eén
   bron, kort venster, handmatig nagekeken.
3. Zoek-UI: transcriptresultaten vindbaar en aanklikbaar. Dit is het punt waarop
   het product zichtbaar beter wordt — daarna pas opschalen.
4. Notubiz-sprekers uit de portal-HTML, met lage concurrency en tolerantie voor
   403.
5. Notubiz-backfill in `media_only`, eerst `live: true`.
6. iBabs stap 1 (`Webcast.Code` parsen) mee met de lopende backfill, en de
   GUID-verificatie uit stap 3.
7. Company Webcast-client + iBabs-slice.
8. Meten of fase A volstaat. Zo niet: fase B als projectiewijziging plus
   `reindex_only`.

Stap 1 t/m 3 leveren al iets bruikbaars op: doorzoekbare gesproken tekst voor de
128 Notubiz-bronnen. Alles daarna vergroot de dekking.

## 9. Risico's

- **Indexgroei bij fase B.** ~23 miljoen rijen bovenop de huidige 57 miljoen.
  Daarom fase A eerst, en meten.
- **Cloudflare op de Notubiz-portals.** Sprekersscraping is het enige onderdeel
  dat kan gaan knellen. Best effort, lage snelheid, en degradeert naar een
  opname zonder sprekerslijst.
- **ASR-kwaliteit.** De SRT's zijn machinaal en bevatten fouten. Zoekresultaten
  op gesproken tekst moeten in de UI herkenbaar anders zijn dan
  documentresultaten, zodat niemand een verkeerd verstane naam als citaat
  overneemt.
- **Persoonsgegevens.** Een transcript is nieuwe vrije tekst en dus nieuw
  BSN-/AVG-oppervlak. De bestaande BSN-detectie draait op documenttekst; die
  moet ook over transcriptsegmenten heen, en `Recording` moet mee in de
  blocklist-check in `executeIngest.onEntity` en in `scripts/delete_document.ts`.
- **Levensduur van URL's.** CWC-signatures verlopen (~1 jaar) en GO-Wowza-tokens
  binnen minuten. Opgeslagen `media_url` is dus geen permalink; de `player_url`
  wel.
- **Niet elk media-URL kan springen.** Gemeten 2026-08-07: Notubiz'
  `media/download` beantwoordt een Range-request met een gewone 200 zonder
  `content-length`, dus een browser kan dat bestand alleen vanaf het begin
  afspelen — klikken op een tijdstip doet niets. Hetzelfde bestand staat wél als
  HLS op Wowza (`https://<host>/<app>/mp4:<stream_name>/playlist.m3u8`,
  afleidbaar uit `streamer` + `stream_name` in de media-respons) en dat is wel
  seekbaar. Vandaar `stream_url` naast `media_url` in het schema. Dit maakt een
  **eigen speler met transcript-synchronisatie** mogelijk in plaats van alleen
  doorlinken; geverifieerd met een lokale proefopstelling
  (`scripts/preview_recording.ts`).
- **iBabs-throttling.** Stap 1 kost nul extra calls, maar loopt wel mee in de
  wachtrij van de backfill. De CWC-route omzeilt dat volledig.

## 10. Bewust niet in dit plan

- **GemeenteOplossingen.** Video en sprekerssegmenten zijn er wel, maar alleen
  via HTML en `risbis.php`, en alles buiten `/api/*` zit achter Anubis
  proof-of-work. Transcripts bestaan alleen live en worden niet gearchiveerd. De
  betere zet is eerst GO vragen dit via hun API te ontsluiten.
- **Parlaeus.** Drie bronnen, publieke video-API met sprekers maar zonder
  transcript. Klein en makkelijk; wachten tot het patroon voor Notubiz en iBabs
  staat.
- **Eigen speech-to-text.** Zou GO en Parlaeus alsnog ontsluiten, maar is een
  eigen project met eigen kosten. Pas overwegen als de leveranciers-transcripts
  bewezen waarde hebben.
