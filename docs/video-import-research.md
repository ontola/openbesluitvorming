# Video, audio en gesproken tekst per leverancier

Onderzoek uitgevoerd 2026-08-06 door live probing van de vier leveranciers-API's
plus de onderliggende videoplatforms. Alles hieronder is geverifieerd tegen de
echte endpoints, niet uit documentatie overgenomen.

## Samenvatting

| Leverancier | Video | Audio | Tijdstempels agendapunt | Sprekersfragmenten | Gesproken tekst | Officiële API? |
| --- | --- | --- | --- | --- | --- | --- |
| Notubiz | ja (mp4) | ja (zelfde endpoint) | ja, in de bestaande meeting-API | ja, alleen in portal-HTML | **ja — SRT, publiek** | grotendeels |
| iBabs | ja (mp4/HLS) | ja (mp3) | ja, via Company Webcast | ja, met timeline-events | **ja — WebVTT, publiek** | nee, via Company Webcast |
| GemeenteOplossingen | ja (mp4/HLS) | ja | ja, per fragment | ja, met start/stop | nee (alleen live) | nee, alleen HTML/`risbis.php` |
| Parlaeus | ja (mp4) | — | ja | ja, met start/end | nee (veld bestaat, leeg) | ja, ongedocumenteerd |

Kernconclusie: **gesproken tekst is er alleen bij Notubiz en iBabs**, en bij
beide is die publiek en gratis op te halen. Dat zijn samen 294 van onze 330
bronnen. Bij GO en Parlaeus krijgen we wel video plus wie-sprak-wanneer, maar
geen transcript — daar zou eigen speech-to-text nodig zijn.

## Notubiz (128 bronnen)

### `GET /media?event_id=<meeting_id>`

Niet eerder gebruikt, publiek, geen token. Eén call per vergadering (geen
bulk-variant; `organisation_id` wordt genegeerd met `Required parameter:
event_id`).

```json
{"media": [{
  "filename": "10.06 en 11.06.26 Amsterdam RAAD.mp4",
  "subtitles": "10_06_en_11_06_26_Amsterdam_RAAD.srt",
  "download_url": "api.notubiz.nl/media/download?folder=Amsterdam&file=…mp4",
  "subtitles_url": "api.notubiz.nl/media/subtitles?folder=Amsterdam&file=….srt",
  "id": 397530, "media_type": "video", "audio_encoding": "aac",
  "video_encoding": "h264", "file_size": 9820745857, "event_id": 1502813
}]}
```

`download_url` en `subtitles_url` komen zonder schema terug — er moet `https://`
voor. Beide getest op Amsterdam, Nunspeet, Haarlem en Laren: HTTP 200,
`video/mp4` respectievelijk `text/plain`. `media_type` is `video` of `audio`.

**`download_url` is niet seekbaar.** Een Range-request krijgt een gewone 200
terug, zonder `content-length` of `accept-ranges`, dus een browser speelt het
bestand alleen vanaf het begin af. De seekbare variant is de HLS-playlist op
Wowza, af te leiden uit `streamer` + `stream_name` uit dezelfde respons:

```
streamer   rtmp://wowza1.notubiz.nl/nbvod/_definst_
stream_name Nunspeet/bestanden/01.04.26 Nunspeet  Raad.mp4
->  https://wowza1.notubiz.nl/nbvod/_definst_/mp4:Nunspeet/bestanden/01.04.26%20Nunspeet%20%20Raad.mp4/playlist.m3u8
```

Getest 2026-08-07: HTTP 200, `application/vnd.apple.mpegurl`, en springen naar
een tijdstip werkt.

### Gesproken tekst

De SRT is een volledig transcript met tijdstempels op zinsniveau:

```
1
00:00:10,140 --> 00:00:11,080
Dames en heren,

2
00:00:13,939 --> 00:00:18,120
ik open deze bijzondere
vergadering van de gemeenteraad van...
```

Grootte: ~30 KB per vergadering, ~1 MB voor een tweedaagse raadsvergadering.
Machinaal gegenereerd (ASR), inclusief herkenbare ASR-fouten, maar prima
doorzoekbaar.

### Tijdstempels en sprekers

`agenda_items[].start_offset` / `end_offset` zitten **al** in de meeting-detail
respons die we vandaag ophalen — seconden vanaf het begin van de opname. Die
hoeven we alleen te gaan opslaan.

Sprekersfragmenten zitten *niet* in de JSON-API: `GET /speaker_indexations?media=<id>`
antwoordt `Zonder authenticatie token kunnen er geen resultaten getoond worden`.
Ze staan wél in de publieke portalpagina (`meeting.url`, bv.
`https://nunspeet.raadsinformatie.nl/vergadering/1412355/Raadsvergadering`):

```html
<li class="speaker_index js_only" id="si_33276894"
    data-si_id="33276894" data-speaker_id="161976"
    data-start_offset="96" data-end_offset="99">
```

Gemeten: 76 sprekersfragmenten en 12 agendapunt-offsets op één Nunspeet-vergadering.
`data-speaker_id` resolvet tegen `GET /organisations/<org>/speakers` naar naam,
partij, functie en foto — dat endpoint is publiek.

Let op: de portals zitten achter Cloudflare en gaven bij een reeks snelle
requests 403. Scrapen kan, maar met een lage snelheid en retries.

### Dekking

Steekproef van 25 bronnen uit onze catalogus, 2026-03-01 t/m 2026-05-31:

- 459 vergaderingen, waarvan **215 met media (47%)**
- 209 video, 6 audio
- **187 van de 215 mediabestanden hebben een SRT (87%)**
- elke bron in de steekproef had media; de 53% zonder media zijn vooral
  commissie-/collegevergaderingen die niet worden uitgezonden

## iBabs (166 bronnen) — via Company Webcast

De SOAP-API geeft alleen `iBabsWebcast.Code`, bv. `amstelveen/20240131_1`. Die
code is gedecodeerd: het is een **Company Webcast** (Royal Cast / webinar.nl)
webcast-id. `https://player.companywebcast.com/amstelveen/20240131_1/nl-NL/player`
redirect naar de echte uitzending. Daarachter zit een volledig publieke API.

### Endpoints (allemaal zonder inloggen)

1. `GET https://sdk.companywebcast.com/players/<klant>_<jjjjmmdd>_<n>/info`
   → GUID, starttijd, duur, HLS-bron, en downloads: **mp4, mp3** en wmv.
2. `GET https://sdk.companywebcast.com/accessrules/<guid>/token`
   → `identificationToken`.
3. `GET https://sdk.companywebcast.com/accessrules/<guid>` met header
   `x-authorization: <token>` → CloudFront `Policy`/`Signature`/`Key-Pair-Id`,
   geldig ongeveer een jaar. Die drie hang je als querystring aan de rest.
4. `GET /players/<guid>/vtt/` → lijst ondertitelsporen, bv.
   `[{"path":"public","id":"NLcorrectie"}]`.
5. `GET /players/<guid>/vtt/public/<track-id>` → **volledig WEBVTT-transcript**.
6. `GET /players/<guid>/ondemand/<x>@rootwrite/resources` → agendapunten
   (`type: topic`, met links naar de iBabs-documenten op `api1.ibabs.eu`),
   sprekers (`type: speaker`) en downloads.
7. `GET /players/<guid>/ondemand/<x>@rootwrite/events/hls/0` → de **timeline**:
   `speakers.speaker:activate` en `index.index:activate` met millisecondestempels,
   dus wie sprak wanneer en welk agendapunt op welk moment liep.

Amstelveen 2024-01-31 als voorbeeld: 307 sprekersfragmenten, 18 agendapunten,
40 downloads, een `NLcorrectie`-transcript (menselijk gecorrigeerd).

### Archief zonder de SOAP-API

`GET https://channel.royalcast.com/portal/api/1.0/<klant>/portalwebcasts/?currentPage=0&status=onDemand&ordering=startDesc&pageSize=30`
geeft de volledige webcast-catalogus per gemeente (`code`, `title`,
`scheduledStart`, `TopicCount`), gepagineerd. We hebben iBabs dus niet nodig om
te weten wélke uitzendingen bestaan — alleen om ze aan een `MeetingId` te
koppelen.

### Dekking

Van onze 162 unieke iBabs-sitenames zijn er **63 Company Webcast-klant** onder
exact dezelfde code (getest op `sdk.companywebcast.com/customers/<site>/poster/…`).
Van die 63:

- 52 leverden een bereikbare afgelopen on-demand-uitzending
- **42 hadden een VTT-transcript** (`nl`, `NLcorrectie`, `Nl-amber`, en
  `frisianSubtitles` voor Tytsjerksteradiel en Waadhoeke)
- 46 hadden een mp4-download; de rest alleen wmv
- 11 gaven HTTP 400 op `portalwebcasts` (Leeuwarden, Hilversum, Kerkrade,
  Noordwijk, Oldambt, Molenlanden, Montfoort, Duiven, Elburg, Lingewaard,
  Brabantse Delta) terwijl `customer` wel bestaat — nog uit te zoeken

De overige 99 sitenames zijn geen CWC-klant onder hun sitename. Wat zij wel
gebruiken (iBabs Stream, een andere CWC-klantcode, YouTube, niets) is alleen te
zien aan het `Webcast.Code`-veld in de SOAP-respons.

**Dat veld kon nu niet gemeten worden:** iBabs throttelt ons productie-IP op dit
moment hard (`[ibabs] breaker open for 900s (throttle 80 in a row)` in
`woozi-worker-2` en `-3`), dus elke SOAP-call vanaf `woozi-1` geeft "The request
is blocked". De dekking van `Webcast.Code` over alle sitenames moet gemeten
worden zodra de backfill klaar is.

## GemeenteOplossingen (33 bronnen)

Video zit **niet** in de gedocumenteerde API. `/api/v2/` documenteert alleen
Attachments, DMUs, Documents, Events, Groups, Meetings, Persons, Positions en
Roles. `/api/v2/speakers` bestaat wel maar is een personenlijst zonder
tijdstempels.

De videodata staat in de portalpagina zelf. Per agendapunt een `.film-fragment`
met een JSON-blob:

```json
{"sources": ["https://59af87d3036de.streamlock.net/vod/_definst_/groningen_1/2026-03-31-16-42-14-gemeenteraad_1.mp4/playlist.m3u8?wowzatokenendtime=…"],
 "type": "film", "fragmentId": 19449,
 "filmName": "gemeenteraad - 31 maart 2026 - Raadzaal - Archief",
 "startTime": 1295, "endTime": 1344,
 "path": "https://go-va-web.gemeenteoplossingen.nl/groningen_1/2026-03-31-16-42-14-gemeenteraad_1.mp4?start=1295&end=1344"}
```

De HLS-URL heeft een Wowza-token met vervaltijd; `path` is een directe
mp4-URL met `start`/`end`. Type is `film` of audio — de agendalegenda kent
"Agendapunt bevat video fragment(en)" en "audio fragment(en)".

Sprekers: `GET /modules/risbis/risbis.php?g=get_speakers_proper&fragment_id=<id>`

```json
[{"start": 1, "stop": 145, "name": "Roelien Kamminga", "url": "/Raadsleden/roelien-kamminga",
  "group": "", "fragment_url": "…/#filmfragment=19449&offset=1"}]
```

Ondertiteling bestaat alleen live: `livesub.gemeenteoplossingen.nl/<streamgenerator>/subs.m3u8`
levert WebVTT-segmenten tijdens de uitzending, met een `hasLiveSubtitles`-vlag in
`risbis.php?g=get_streaming_meeting`. De archiefspeler laadt geen ondertitels.
Er is dus geen opvraagbaar transcript achteraf.

**Obstakel:** alles behalve `/api/*` zit achter Anubis proof-of-work (versie
1.25.0, difficulty 4, algoritme `fast`). Getest op Alblasserdam, Groningen,
Dordrecht, Den Helder en Doetinchem — allemaal. De challenge is scriptbaar
(SHA-256 PoW, de resulterende JWT-cookie is 7 dagen geldig), maar we moeten dan
per site één keer per week een PoW oplossen voordat we HTML of `risbis.php`
mogen ophalen.

## Parlaeus (3 bronnen)

De open-data-API (`fn=agenda_list`, `agenda_detail`, `cie_list`, `person_list`)
heeft geen video; alle andere `fn`-namen die ik probeerde geven
`{"message":"No such function","status":501}`.

De portal-app heeft wel een publiek endpoint:

`GET https://<gemeente>.parlaeus.nl/vji/public/agendavideo/action=detaildata/ag=<agid>`

`ag` is exact de `agid` die we al uit `agenda_list` halen. De respons bevat:

- `player.VIDEO_DOWNLOAD` — directe mp4-URL (bij Apeldoorn Azure blob storage)
- `player.VIDEO_PLAYER.stream_type` — de app ondersteunt `videojs`,
  **Streamovations**, **Company Webcast**, **YouTube** en **PartnerTV**; alle
  drie onze gemeenten staan op `videojs`
- `player.VIDEO_PLAYER.cc` — ondertitelsporen, leeg bij alle drie
- `indexdata.ndx[]` — per agendapunt `start`/`end` in seconden plus `point`
  (de `ap_rule_hexkey`), en `votes[]`
- `indexdata.ndx[].mb[]` — sprekers met `start`, `end`, `name`, `chairman`, en
  een `transcript`-veld dat overal leeg is

Gemeten (mei–juni 2026): Apeldoorn 4 van 12 agenda's met video, Bodegraven-Reeuwijk
9 van 9 (117 sprekersfragmenten op de gecontroleerde vergadering), Maastricht 7
van 12 (368 sprekersfragmenten). De `council`-variant van hetzelfde endpoint
geeft 401 — alleen de `public`-variant werkt zonder login.

## Wat dit betekent voor de import

Het goedkope deel is groot: transcripts zijn ~30 KB per vergadering en
tijdstempels zijn een paar honderd bytes. Dat is direct indexeerbaar in Quickwit
en maakt "zoek op wat er gezegd is" mogelijk voor Notubiz en iBabs samen — het
grootste deel van onze dekking.

Het dure deel is video: één Amsterdamse tweedaagse raadsvergadering is 9,8 GB,
een gemiddelde gemeenteraad 200–400 MB. Video zelf hoort niet in onze S3 —
opslaan als URL plus metadata, en de gebruiker naar de bron laten diepe-linken
met een offset.

Er is één natuurlijke join per leverancier:

- Notubiz: `event_id` = ons meeting-id; `agenda_items[].start_offset` zit al in
  de payload die we ophalen
- iBabs: `Webcast.Code` uit `GetMeetingsByDateRange`; de CWC-`topic`-resources
  dragen een `reference`-GUID die naar het iBabs-agendapunt lijkt te wijzen (nog
  te verifiëren zodra de SOAP-API weer bereikbaar is)
- GO: `fragmentId` per agendapunt, alleen uit de HTML
- Parlaeus: `agid` uit `agenda_list`, en `point` = `ap_rule_hexkey` per agendapunt

## Open vragen

- Hoe groot is de `Webcast.Code`-dekking over alle 162 iBabs-sitenames, en wat
  gebruiken de 99 niet-CWC-sites?
- Waarom geven 11 CWC-klanten HTTP 400 op `portalwebcasts`?
- Is de CWC-`topic.reference` echt het iBabs-`MeetingItem`-id?
- Kunnen we bij Notubiz een token krijgen voor `/speaker_indexations`, zodat we
  de portal-HTML niet hoeven te scrapen?
- Willen we bij GO en Parlaeus zelf speech-to-text draaien, of alleen linken?
- Is de Anubis-PoW bij GO acceptabel om te automatiseren, of vragen we GO om de
  video-data via hun API te ontsluiten?
