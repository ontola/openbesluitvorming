# Open Raadsinformatie API docs

Open Raadsinformatie (ORI) aims to make governmental decision making more transparent
by aggregating and standardizing meeting & decision data.
Currently, the API includes data from more than 110 municipalities (gemeenten) and 5 provinces.

## Endpoints

The ORI API has several endpoints for different goals:

- the **REST API** for fetching individual resources
- an **Elastic** endpoint for full-text search

### REST API

Endpoint: [`https://id.openraadsinformatie.nl`](https://id.openraadsinformatie.nl)

The ORI REST API is hofsted at the `id.openraadsinformatie.nl` subdomain.
Use this to get individual meetings / motions / agenda items / persons / etc, such as [`https://id.openraadsinformatie.nl/243815`](https://id.openraadsinformatie.nl/243815).
It is by far the most performant API for ORI, as it stores the various representations (TTL, RDF/XML, N3, N-Triples, JSON-LD) as static files.
Since this API serves RDF, it might be a good idea to [get familiar with linked data](https://ontola.io/what-is-linked-data/).

There is a special endpoint for getting all organizations: [`https://api.openraadsinformatie.nl/v1/organizations`](https://api.openraadsinformatie.nl/v1/organizations)

Read more about the REST API in its [github repo](https://github.com/ontola/ori_api) and its [documentation](https://id.openraadsinformatie.nl/).

If you want to see some examples of how to query this endpoint, check out [`example_requests.http`](/example_requests.http).

### Elastic

Endpoint: `https://api.openraadsinformatie.nl/v1/elastic/`

This is an ElasticSearch endpoint.
Elastic has powerful full-text search capabilities.

The repo for this API can be found [here](https://github.com/openstate/open-raadsinformatie).
Read the [Elastic v7.0](https://www.elastic.co/guide/en/elasticsearch/reference/7.0/index.html) docs for more information.
Only specific Elastic features (endpoints) are publicly available.
This is to prevent (malicious or accidental) write / remove commands.

If you want to see some examples of how to query this endpoint, check out [`example_requests.http`](/example_requests.http).

## Changes from V0

The previous API version, V0, was available at `https://api.openraadsinformatie.nl/v1/`.
These things are different in V1 from V0:

- ElasticSearch was upgraded from 5 to 7 ([upgrade guide](https://www.elastic.co/guide/en/cloud/current/ec-upgrading-v7.html))
- Events are now split between "Meetings" and "AgendaItems"
- The new REST API for performant Linked Data resource fetching
- Documents are no longer nested under Events
- PDF documents are cached, so now it's possible to query from sources that had no support for this (such as iBabs)
- An `@context` json object was added in ElasticSearch for [RDF](https://www.w3.org/RDF/) / [JSON-LD](https://json-ld.org) compliance.
- A `discussed_at` field is added to AgendaItems and Documents.
- The available keys in the resources still adhere to Popolo where possible, so they have not changed.
- Text of extracted documents is now paginated, it's an array of pages.

## FAQ

## How is your data standardized?

Most of our data follows the international [Popolo](https://www.popoloproject.com) specification.
We've added a couple of concepts, such as AgendaItems, which are namespaced under the Meeting ontology.
This Meeting ontology is a [work in progress](https://github.com/openstate/open-raadsinformatie/issues/127).

In the future, we hope to use the [VNG Open Raadsinformatie spec](https://github.com/VNG-Realisatie/Open-Raadsinformatie/) for serialization.

### Who's behind this project?

ORI was initiated by the [Open State Foundation](https://openstate.eu).
[VNG Realisatie](https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie) is the main funder.
[Ontola](https://ontola.io) / [Argu](https://argu.co) is responsible for the technology.

### I have feedback / question about one of the API's

For technical questions, please create an issue in the aforementioned Github repos.
If you have general questions about Open Raadsinformatie, get in touch with project leader [Sander Bakker](mailto:sander.bakker@vng.nl)

### Who uses ORI / these APIs?

- [1848.nl](https://1848.nl) (contact: Lucas Benschop)
- Semantic Analysis ORI (contact: Robert Goené)
- [WaarOverheid](https://waaroverheid.nl/) (contact: Alex Olieman)
- HierOverheid (in progress) (contact: Alex Olieman)
- [Argu.co](https://argu.co) (contact: Joep Meindertsma)
- Oberon Open Stateninformatie - Browser plugin (contact: Hans-Peter Harmsen)
- Your app here? [Let us know](mailto:joep@ontola.io)!
