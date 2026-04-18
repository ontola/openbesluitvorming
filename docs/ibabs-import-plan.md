# iBabs Import Plan

## Current State

The iBabs integration is mostly built:
- SOAP client (`src/ibabs/client.ts`) — calls `wcf.ibabs.eu/api/Public.svc`
- Extractor (`src/ibabs/extractor.ts`) — fetches meetings, normalizes, materializes documents
- Normalizer (`src/ibabs/normalize.ts`) — converts to canonical entities
- 165 iBabs sources in the catalog (`src/sources/catalog.data.ts`), all marked `implemented: true`
- Tests with XML fixtures

It has never been run in production.

## Challenges

### 1. IP Whitelisting

iBabs uses IP-based access control. Only our production server (`91.98.32.151`) is whitelisted. This means:
- Local development can't hit the iBabs API directly
- Extraction workers on Hetzner Cloud (dynamic IPs) can't hit it either
- Only the ingest worker running on `woozi-1` can make iBabs API calls

**Solution: SSH tunnel / SOCKS proxy**

Route iBabs API traffic through the production server:

```sh
# On your local machine:
ssh -D 1080 -N root@91.98.32.151
```

Then configure the iBabs client to use the SOCKS proxy. In Deno, this requires a proxy agent or routing through a local HTTP proxy like `proxychains`.

A simpler approach: **just run iBabs imports on the production worker**. The worker already runs there. iBabs doesn't need extraction workers (documents are smaller and less numerous than Notubiz). The SOAP API returns all meetings in one call — no pagination, no concurrency needed.

For local development/testing, use the existing XML test fixtures rather than hitting the live API.

### 2. Sequential Processing

The iBabs extractor processes everything sequentially — no `mapLimit` for meetings or documents. This is fine for now since:
- iBabs returns all meetings in one SOAP call (no pagination)
- Most iBabs municipalities have fewer documents than Notubiz equivalents
- The bottleneck is the API call itself, not local processing

Can be parallelized later if needed.

### 3. No Pagination

The iBabs client fetches all meetings for a date range in a single SOAP call (`GetMeetingsByDateRange`). For large date ranges (e.g. 5 years), this could:
- Time out on the iBabs side
- Return a very large XML response

**Mitigation:** Split large imports into smaller date ranges (e.g. 3-month chunks). This could be done automatically in the extractor or manually in the admin panel.

### 4. GetListEntries API

Someone reported that iBabs has a `GetListEntries` method for events, but it requires username/password authentication (not available on the public API). This could be more efficient than `GetMeetingsByDateRange`.

**Action items:**
- Contact iBabs to request credentials for `GetListEntries`
- Investigate whether this API provides data we can't get from the public API (e.g. vote data, attendee lists)
- If credentials are obtained, add an authenticated client alongside the public one

### 5. Extraction Workers

For iBabs document extraction (PDFs), we have two options:

**Option A: Extract on the ingest worker (simplest)**
The worker on `woozi-1` downloads documents and sends them to extraction workers for PDF processing, same as Notubiz. The iBabs API calls happen on the worker (whitelisted IP), but PDF extraction is offloaded.

**Option B: Extract locally with tunnel**
Use an SSH tunnel for API calls but process documents locally. More complex, only useful for development.

Recommendation: **Option A** — iBabs API calls happen on the production worker, extraction is offloaded to workers. No tunnel needed in production.

## Implementation Steps

### Phase 1: Smoke test on production

1. SSH into production server
2. Trigger a small iBabs import from the admin panel (one municipality, one month)
3. Verify the SOAP client connects and returns data
4. Check that documents are downloaded and extracted
5. Verify search results appear in Quickwit

```sh
# From admin panel or via API:
curl -X POST https://beta.openbesluitvorming.nl/api/admin/rerun \
  -H "Content-Type: application/json" \
  -d '{"sourceKey":"amstelveen","dateFrom":"2024-06-01","dateTo":"2024-07-01","executionMode":"full"}'
```

### Phase 2: Fix issues from smoke test

Likely issues:
- SOAP response parsing edge cases with real data
- Document download URLs that differ from test fixtures
- Date format variations
- Missing or confidential documents

### Phase 3: Bulk import

1. Run iBabs imports for all 165 sources
2. Monitor for IP whitelisting issues — some iBabs "sitenames" might require separate whitelisting
3. Split large date ranges if needed

### Phase 4: Ongoing imports

Add iBabs sources to the daily import cron alongside Notubiz. Since iBabs runs on the production worker and doesn't need extraction workers for small daily imports, this should work without additional infrastructure.

## Local Development

For local development without the production tunnel:

1. **Use test fixtures** — existing XML fixtures in `tests/fixtures/ibabs_*.xml` cover the happy path
2. **Mock the SOAP client** — the client has a clean interface that can be mocked in tests
3. **Record real responses** — add a recording mode that saves SOAP responses as fixtures for offline development

For occasional local testing against the real API:

```sh
# Terminal 1: SSH tunnel
ssh -L 8443:wcf.ibabs.eu:443 root@91.98.32.151

# Then set IBABS_PUBLIC_URL=https://localhost:8443/api/Public.svc
# (requires accepting self-signed cert or using --insecure)
```

A cleaner alternative: **HTTP forward proxy on the production server** that forwards iBabs traffic:

```sh
# On production server, run a simple proxy (e.g. tinyproxy, squid, or caddy)
# On local machine, set HTTP_PROXY=http://91.98.32.151:8888
```

But honestly, running imports on the production worker and using fixtures locally is simpler than maintaining a proxy setup.

## Architecture Notes

- iBabs uses SOAP/XML, Notubiz uses JSON REST — the client layer abstracts this, the rest of the pipeline is identical
- Both suppliers share the same `materializeDocument`, Quickwit projection, and S3 storage paths
- The admin panel already supports iBabs sources in the source picker (they're in the catalog)
- The extraction service doesn't need changes — it receives PDF bytes regardless of the source supplier

## API Exploration Results (2026-04-17)

### Available SOAP Operations (28 total)

Discovered via WSDL at `https://wcf.ibabs.eu/api/Public.svc?wsdl`:

| Operation | Description | Status |
|-----------|-------------|--------|
| `GetMeetingsByDateRange` | Fetch meetings | **Working** |
| `GetMeetingtypes` | List meeting types | **Working** |
| `GetUsers` | List council members | **Working** (70 users for Amstelveen) |
| `GetLists` | List registries (moties, amendementen, etc.) | **Working** (14 lists for Amstelveen) |
| `GetListEntryVotes` | Per-entry vote details | **Access denied** |
| `GetListEntryVotesByListEntryId` | Votes for specific entry | **Not tested** |
| `GetUserVotes` | All votes by a user | **Returns empty** |
| `GetMeetingsChangedSince` | Delta sync | **Not tested** |
| `GetMeetingsDeletedSince` | Deleted meetings | **Not tested** |
| `GetMeetingsDepublishedSince` | Depublished meetings | **Not tested** |
| `GetListEntry` | Single list entry detail | **Not tested** (requires auth?) |
| `GetListEntries` / `GetListsEntriesByFilterRequest` | Bulk list entries | **Requires username/password** |
| `Search` | Full-text search | **Error** (needs date params) |

### Vote Data

The `iBabsMeetingItem` schema has vote count fields:
- `HasVotes: boolean`
- `VotesInFavour: int`
- `VotesAgainst: int`

However, these are **always 0** in the public API responses tested (Amstelveen, Rotterdam, Utrecht). The vote data likely requires:
- Authenticated access via `GetListEntryVotes` (returns "Access denied" on public API)
- Or is only populated for municipalities that actively use iBabs's voting module

The `GetUsers` endpoint works and returns council members with `CanVote` flags, but `GetUserVotes` returns empty results.

**Conclusion:** Structured vote counts exist in the schema but are not accessible via the public API. Getting real vote data would require negotiating authenticated API access with iBabs.

### Webcast / Video Data

The `iBabsWebcast` type contains only a `Code: string` field. Observed codes:
- `amstelveen/20240131_1`
- `amstelveen/20240228_1`

These are identifiers for iBabs's hosted webcast platform. **No transcripts, spoken text, or video URLs** are available in the API. The webcast code can be stored as metadata, but accessing the actual video/audio would require:
- iBabs's webcast platform (separate from the SOAP API)
- Possibly an embed URL pattern (not documented, redirects to homepage)
- Transcription would need to be done externally (download video → speech-to-text)

**No spoken text / transcript data exists in the iBabs API.**

### Lists (Registries)

Amstelveen has 14 registries:
- Amendementen, Moties, Toezeggingen, Schriftelijke vragen
- Besluitenlijsten van de raad/college
- Woo verzoeken, Klachten, etc.

These are accessible via `GetLists` but entries require `GetListEntries` (authenticated) or `GetListEntry` to fetch individually. The `ListEntries` field on `iBabsMeetingItem` could link agenda items to registry entries, but it's empty in tested responses.

### IPv4 Requirement

iBabs IP whitelisting is **IPv4 only**. The production server has both IPv4 (`91.98.32.151`) and IPv6 (`2a01:4f8:c014:6bb3::1`). API calls must be forced over IPv4 — the default IPv6 route gets rejected.

This affects:
- The SOCKS proxy setup (SSH `-D` doesn't force IPv4 for proxied traffic)
- Docker DNS resolution (may prefer IPv6)
- Extraction workers (dynamic IPs, not whitelisted)

**For production:** The iBabs client should force IPv4 resolution, or the worker should be configured to prefer IPv4 for `wcf.ibabs.eu`.

### First Successful Import Test

A test extraction of Utrecht (2024-06-01 to 2024-06-15) returned:
- 14 meetings
- Documents downloading and extracting successfully
- Sequential processing (one document at a time)
- Large PDFs (34 MB) took ~96 seconds

## Open Questions

- Do all 165 iBabs sitenames work with our single IP whitelist, or do some require separate approval?
- Can we negotiate authenticated API access with iBabs for vote data (`GetListEntryVotes`, `GetListEntries`)?
- Is there a public URL pattern for iBabs webcasts (to embed or link to videos)?
- How does iBabs handle document versioning — can documents change after initial publication?
- Should we use `GetMeetingsChangedSince` for incremental sync instead of re-fetching full date ranges?
