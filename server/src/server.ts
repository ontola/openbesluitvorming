import path from "path";

import cors from "cors";
import express, { Response, Request } from "express";
import httpProxyMiddleware from "http-proxy-middleware";
import morgan from "morgan";
import simple_oauth2 from "simple-oauth2";

import * as http from "http";

require("dotenv").config();

import { ES_URL, PORT, WWW_DIR } from "./config";



const app = express();


const TAPI_ROOT_URL = "https://topics-dev.platform.co.nl/"
const clientID = "7gqU433Z1Uos90DxHijN7NRvuJeGrncutjbkOnst";
const clientSecret = "sVz9XlfXu194UFc9Ft1Se9Dz3Xjk2R2PNEOOq9BL43LNDIJDFQLagTqB5Vv96dwO5NGqjORyzBkwfxJWi8FxxWQyaxbVeZMVHWSASYi5vlCoPe5dfMqmHsxT4pxBJCsI";

const credentials = {
  client: {
    id: clientID,
    secret: clientSecret
  },
  auth: {
    tokenHost: TAPI_ROOT_URL,
    tokenPath: '/o/token'
  }
}

const oauthClient = simple_oauth2.create(credentials)

// let accessTokenObject;
let accessToken: String;

oauthClient.clientCredentials.getToken({}).then(result => {
  accessToken = result.access_token
  console.log('Access token received:', accessToken);
}).catch(error => {
  console.log("Error getting access token for TAPI:", error);
})

function onProxyReq(proxyReq: http.ClientRequest, req: http.IncomingMessage, res: http.ServerResponse) {
  proxyReq.setHeader('Authorization', 'Bearer ' + accessToken)
}
console.log(onProxyReq);




// Enable all CORS requests
app.use(cors());
// Logger middleware
app.use(morgan("combined"));

// Proxy search requests
app.all("/api/*", httpProxyMiddleware({
  ws: true,
  target: ES_URL,
  changeOrigin: true,
  pathRewrite: { "^/api": "" },
  logLevel: process.env.NODE_ENV === "production" ? "info" :  "debug",
}));

// console.log(TAPI_ROOT_URL);
// app.all("/topics_api/*", httpProxyMiddleware({
//   ws: true,
//   target: TAPI_ROOT_URL,
//   changeOrigin: true,
//   onProxyReq,
//   pathRewrite: { "^/topics_api": "" },
//   logLevel: process.env.NODE_ENV === "production" ? "info" :  "debug",
// }));

const apiProxy = httpProxyMiddleware(
  '/topics_api', 
  {
    ws: true,
    target: TAPI_ROOT_URL,
    changeOrigin: true,
    onProxyReq,
    pathRewrite: {"^/topics_api": ""}
  }
);
app.use(apiProxy);

// Production, serve static files
app.use(express.static(path.join(WWW_DIR)));


app.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(WWW_DIR, "index.html"));
});

app.listen(PORT);

