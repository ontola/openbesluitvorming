# Open Raadsinformatie Search
[![Build Status](https://semaphoreci.com/api/v1/projects/9f55dbcb-3683-40e7-8f0c-293cea710d01/2575606/badge.svg)](https://semaphoreci.com/argu/ori-search)

A webapplication that searches through meeting documents of many Dutch local governments by using [Open Raadsinformatie](http://openraadsinformatie.nl).

Check it out at [ori.argu.co](http://ori.)!

## Run front-end

- `cd front`
- `yarn start`

## Run server

- `cd server`
- `yarn dev`

## Run using docker

- Buid the docker image `docker build . -t ori_search:latest`
- Run it `docker run -it -p 8080:8080 -e PORT=8080 ori_search:latest`
- Visit `http://localhost:8080`

## Contributing

Great, read [CONTRIBUTE.md](/CONTRIBUTE.md)!

## Deployment

Semaphore tracks the master branch and deploys succesful builds to [docker hub](https://hub.docker.com/r/argu/ori-search).

## Architecture

The front-end is a typescript react application that uses [reactiveserach](https://github.com/appbaseio/reactivesearch/issues).

The server is a node express application that serves as both a proxy and a static file server.

## Thanks to

- [VNG Realisatie](https://vngrealisatie.nl) for funding.
- [Open State Foundation](https://openstate.eu/nl/) for giving feedback on this project and starting Open Raadsinformatie.
- [Argu](https://argu.co) for software development.
