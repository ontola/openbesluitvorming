# Open Raadsinformatie Search

[![Build Status](https://semaphoreci.com/api/v1/argu/ori-search-2/branches/master/badge.svg)](https://semaphoreci.com/argu/ori-search-2)

Search through meeting documents of 100+ Dutch local governments. Powered by [Open Raadsinformatie](https://github.com/openstate/open-raadsinformatie/).

Check it out at [ori.argu.co](http://ori.argu.co)!

## Using the ORI API

Check out the [API docs](/docs.md) and the [example requests](/example_requests.http).

## Run front-end

- `cd front`
- `yarn`
- `yarn dev`

## Run server

- `cd server`
- `yarn`
- `yarn dev`

## Run using docker

- Buid the docker image `docker build . -t argu/ori-search`
- ... Or pull it from [dockerhub](https://hub.docker.com/r/argu/ori-search): `docker pull argu/ori-search`
- Run it `docker run -it -p 8080:8080 -e PORT=8080 argu/ori-search`
- Visit `http://localhost:8080`

## Contribution guidelines

Read [contribute.md](/CONTRIBUTE.md)

## Deployment

Semaphore tracks the master branch and deploys succesful builds to a public [docker hub](https://hub.docker.com/r/argu/ori-search) repository.

## Architecture

The [front-end](/front) is a search and browse GUI.
It's a typescript react application that uses [reactiveserach](https://github.com/appbaseio/reactivesearch) for search components, [link-redux](https://github.com/fletcher91/link-redux) for linked data (RDF) resource rendering and [react-pdf](https://github.com/wojtekmaj/react-pdf) to display PDF files.

The [server](/server) is a node express application that serves as both a static file server and a proxy that forward elasticsearch queries to the elastic endpoint of open raadsinformatie.

## Connecting with Elasticsearch

Make sure ES has the [correct proxy settings](https://opensource.appbase.io/reactive-manual/getting-started/reactivebase.html#connect-to-elasticsearch).

## Credits

- [VNG Realisatie](https://vngrealisatie.nl) for funding.
- [Open State Foundation](https://openstate.eu/nl/) for providing useful feedback on this project and starting Open Raadsinformatie.
- Software developed by [Joep Meindertsma](http://github.com/joepio) from [Argu](https://argu.co) / [Ontola](https://ontola.io).
- Feedback from @breyten, @aolieman, @fletcher91, @jurrian
- Various open source projects that we're using, most notably ReactiveSearch and Link-Lib. Check out the `package.json` files to see which projects were used.
- [@aolieman](http://github.com/aolieman) and [Hendrik](http://github.com/henkieeeee) fpr implementing the Glossary feature (select text in PDF to view definition).
