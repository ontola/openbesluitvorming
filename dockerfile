FROM node:11 as builder
WORKDIR /usr/src/app

COPY front/package.json front/yarn.lock ./front/
COPY server/package.json server/yarn.lock ./server/
WORKDIR /usr/src/app/server
RUN yarn --frozen-lockfile
WORKDIR /usr/src/app/front
RUN yarn --frozen-lockfile
WORKDIR /usr/src/app/
COPY ./front ./front
COPY ./server ./server/
WORKDIR /usr/src/app/server
RUN yarn run build
WORKDIR /usr/src/app/front
RUN yarn run build

# Production
FROM node:11-alpine
WORKDIR /usr/src/app

COPY server/package.json server/yarn.lock ./
RUN yarn install --production --frozen-lockfile

COPY --from=builder /usr/src/app/server/dist/ /usr/src/app/
COPY --from=builder /usr/src/app/front/build /usr/src/app/www/

EXPOSE 8080
CMD ["node", "server.js"]
