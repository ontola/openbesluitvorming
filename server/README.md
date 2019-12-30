# ori-search server

This typescript node application serves as a static file server and a proxy for the frontend.

## Usage

`$ yarn dev`

## Envs

``` env
ES_URL=Link to elasticsearch endpoint
PORT=Port of this server.
WWW_DIR=Path to the static files. Should be "../front/build" for local development, if you want to serve the local
SEARCH_GLOSS_CLIENT_ID= ask Qollap / Waaroverheid @aolieman
SEARCH_GLOSS_CLIENT_SECRET= ask Qollap / Waaroverheid @aolieman
```
