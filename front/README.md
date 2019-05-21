# Open Raadsinformatie Zoekmachine

## Usage

`$ yarn`

`$ yarn dev` starts a local development server uses react-scripts.
This has a built-in proxy, which forwards all /api request to the `../server` app at :8080.

Visit localhost:3000

## Build

Use `yarn build`, and serve the static files using the `../server` app.

## Envs

The default envs are set for production. For local development,

``` env
SERVER_PORT=Port of the `../server`. Is only used in development, since the server points to `/api`
FRONTEND_URL=Link to where this front-end application should run
FRONTEND_ACCEPT=MIME format
```

## How it renders stuff

The search results are plain React components that use the JSON objects from ReactiveSearch / Elastic.
The LinkedResourceContainer uses `link-lib`
