# Open Raadsinforamtie API docs

Open Raadsinformatie (ORI) aims to make governmental decision making more transparent
by aggregating and standardizing meeting & decision data.
Currently, the API includes data from more than 110 municipalities (gemeenten) and 5 provinces.

## Endpoints

The ORI API has several endpoints for different goals:

- the **REST API** for fetching individual resources: `https://id.openraadsinformatie.nl`
- an **Elastic** endpoint for full-text search: `https://api.openraadsinformatie.nl/v1/elastic/`
- a **NEO4j** endpoint for graph search `https://api.openraadsinformatie.nl/v1/neo/`

### REST API

The ORI REST API is hosted at the `id.openraadsinformatie.nl` subdomain.
Use this to get individual meetings / motions / agenda items / persons / etc.
It is by far the most performant API for ORI, as it stores the various representations (TTL, RDF/XML, N3, N-Triples, JSON-LD) as static files.
Since this API serves RDF, it might be a good idea to [get familiar with linked data](https://ontola.io/what-is-linked-data/).

Read more about the REST API in its [github repo](https://github.com/ontola/ori_api).

### Elastic

This is an ElasticSearch v7.0 endpoint.
Elastic has powerful full-text search capabilities.

The repo for this API can be found [here](https://github.com/openstate/open-raadsinformatie)

### NEO4j (Cypher / Gremlin)

If you need specific graph query questions, you can use the NEO4j endpoint.
Get in touch with

## Example requests

If you want to know how to query the endpoints, see some examples in [`example_requests.http`](/example_requests.http).

## FAQ

### Who's behind this project?

ORI was initiated by the [Open State Foundation](https://openstate.eu).
[VNG Realisatie](https://www.vngrealisatie.nl/producten/pilots-open-raadsinformatie) is the main funder.
[Ontola](https://ontola.io) / [Argu](https://argu.co) is responsible for the technology.

### I have feedback / question about one of the API's

For technical questions, please create an issue in the aforementioned Github repos.
If you have general questions about Open Raadsinformatie, get in touch with project leader [Sander Bakker](mailto:sander.bakker@vng.nl)
