# Open Raadsinformatie API docs

Open Raadsinformatie (ORI) aims to make governmental decision making more transparent
by aggregating and standardizing meeting & decision data.
Currently, the API includes data from more than 110 municipalities (gemeenten) and 5 provinces.

## Endpoints

The ORI API has several endpoints for different goals:

- the **REST API** for fetching individual resources
- an **Elastic** endpoint for full-text search

If you want to know how to query these endpoints, check out [`example_requests.http`](/example_requests.http).

### REST API

Endpoint: `https://id.openraadsinformatie.nl`

The ORI REST API is hofsted at the `id.openraadsinformatie.nl` subdomain.
Use this to get individual meetings / motions / agenda items / persons / etc, such as [`https://id.openraadsinformatie.nl/243815`](https://id.openraadsinformatie.nl/243815).
It is by far the most performant API for ORI, as it stores the various representations (TTL, RDF/XML, N3, N-Triples, JSON-LD) as static files.
Since this API serves RDF, it might be a good idea to [get familiar with linked data](https://ontola.io/what-is-linked-data/).

There is a special endpoint for getting all organizations: [`https://api.openraadsinformatie.nl/v1/organizations`](https://api.openraadsinformatie.nl/v1/organizations)

Read more about the REST API in its [github repo](https://github.com/ontola/ori_api) and its [documentation](https://id.openraadsinformatie.nl/).

### Elastic

Endpoint: `https://api.openraadsinformatie.nl/v1/elastic/`

This is an ElasticSearch endpoint.
Elastic has powerful full-text search capabilities.

The repo for this API can be found [here](https://github.com/openstate/open-raadsinformatie).
Read the [Elastic v7.0](https://www.elastic.co/guide/en/elasticsearch/reference/7.0/index.html) docs for more information.
Only specific Elastic features (endpoints) are publicly available.
This is to prevent (malicious or accidental) write / remove commands.

## FAQ

### Who's behind this project?

ORI was initiated by the [Open State Foundation](https://openstate.eu).
[VNG Realisatie](https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie) is the main funder.
[Ontola](https://ontola.io) / [Argu](https://argu.co) is responsible for the technology.

### I have feedback / question about one of the API's

For technical questions, please create an issue in the aforementioned Github repos.
If you have general questions about Open Raadsinformatie, get in touch with project leader [Sander Bakker](mailto:sander.bakker@vng.nl)
