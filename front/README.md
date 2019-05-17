# Open Raadsinformatie Zoekmachine

## Usage

`$ yarn`

`$ yarn dev` starts a local development server uses react-scripts. This has a built-in proxy.

## Envs

``` env
PORT=Port of the server
FRONTEND_URL=Link to where this front-end application should run
FRONTEND_ACCEPT=MIME format
```

## How it renders stuff

The search results are plain React components that use the JSON objects from ReactiveSearch / Elastic.
The LinkedResourceContainer uses `link-lib`
