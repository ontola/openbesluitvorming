import path from "path";

import cors from "cors";
import express, { Response, Request } from "express";
import httpProxyMiddleware from "http-proxy-middleware";
import morgan from "morgan";

import { ES_URL, PORT, WWW_DIR } from "./config";

const app = express();

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

// Production, serve static files
app.use(express.static(path.join(WWW_DIR)));

app.get("*", (req: Request, res: Response) => {
  res.sendFile(path.join(WWW_DIR, "index.html"));
});

app.listen(PORT);
