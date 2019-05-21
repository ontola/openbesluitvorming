# Open Raadsinformatie Search

Search through meeting documents of 100+ Dutch local governments. Powered by [Open Raadsinformatie](http://openraadsinformatie.nl).

Check it out at [ori.argu.co](http://ori.argu.co)!

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

[![Build Status](https://semaphoreci.com/api/v1/argu/ori-search-2/branches/master/badge.svg)](https://semaphoreci.com/argu/ori-search-2)

Semaphore tracks the master branch and deploys succesful builds to a public [docker hub](https://hub.docker.com/r/argu/ori-search) repository.

## Architecture

The [front-end](/front) is a typescript react application that uses [reactiveserach](https://github.com/appbaseio/reactivesearch) for elasticsearch and [link-redux] for linked data (RDF) rendering.

The [server](/server) is a node express application that serves as both a static file server and a proxy that forward elasticsearch queries to the elastic endpoint of open raadsinformatie.

## Credits

- [VNG Realisatie](https://vngrealisatie.nl) for funding.
- [Open State Foundation](https://openstate.eu/nl/) for providing useful feedback on this project and starting Open Raadsinformatie.
- Software developed by @joepio from [Argu](https://argu.co) / [Ontola](https://ontola.io).
- Feedback from @breyten, @aolieman, @fletcher91, @jurrian
