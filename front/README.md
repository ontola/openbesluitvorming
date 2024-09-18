# ORI-search front

This is the front-end react typescript application.
It uses [reactivesearch](https://github.com/appbaseio/reactivesearch/) for search / filter components, and [link-redux](https://github.com/fletcher91/link-redux) for rendering RDF data.

## Usage

`$ pnpm` get all node dependencies, run after pulling

`$ pnpm dev` starts a local development server uses react-scripts.
This has a built-in proxy, which forwards all /api request to the `../server` app at :8080.

Visit [localhost:4000](http://localhost:4000/)

## Build

`$ pnpm build`, and serve the static files using the `../server` app.

## Envs

The default envs are set for production. For local development,

``` env
SERVER_PORT=Port of the `../server`. Is only used in development, since the server points to `/api`
FRONTEND_URL=Link to where this front-end application should run
FRONTEND_ACCEPT=MIME format
```
