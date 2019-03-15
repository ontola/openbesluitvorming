# Open Raadsinformatie Search
[![Build Status](https://semaphoreci.com/api/v1/projects/9f55dbcb-3683-40e7-8f0c-293cea710d01/2575606/badge.svg)](https://semaphoreci.com/argu/ori-search)

A search webapplication that uses [Open Raadsinformatie](http://openraadsinformatie.nl) data.

## Run front-end

- `cd front`
- `yarn dev`

## Run server

- `cd server`
- `yarn dev`

## Run using docker

- Buid the docker image `docker build . -t ori_search:latest`
- Run it `docker run -it -p 8080:8080 -e PORT=8080 ori_search:latest`
- Visit `http://localhost:8080`
