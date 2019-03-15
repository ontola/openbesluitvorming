import path from "path";

import cors from "cors";
import express, { Response, Request } from "express";
import httpProxyMiddleware from "http-proxy-middleware";
import morgan from "morgan";

const staticDir = process.env.WWW_DIR || "/usr/src/app/www/";
const defaultPort = 8080;
const app = express();

// Enable all CORS requests
app.use(cors());
// Logger middleware
app.use(morgan("combined"));

// Proxy search requests
app.all("/search", httpProxyMiddleware({
  target: "https://api.openraadsinformatie.nl/v1/elastic/",
  changeOrigin: true,
  pathRewrite: { "^/search": "" },
  logLevel: process.env.NODE_ENV === "production" ? "info" :  "debug",
}));

// Production, serve static files
app.use(express.static(path.join(staticDir)));

app.get("*", (req: Request, res: Response) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(process.env.PORT || defaultPort);
