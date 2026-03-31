import type {
  AdminRerunRequest,
  AdminSourcesResponse,
  EntityContentResponse,
  SearchResponse,
} from "../src/types.ts";
import { startIngest } from "../src/ingest.ts";
import { getRunDetails, listRuns } from "../src/ops/store.ts";
import { notubizSources } from "../src/sources/notubiz.ts";
import { getEntityContent, searchMeetings } from "./search_api.ts";

const root = new URL("./", import.meta.url);
const distRoot = new URL("./dist/", import.meta.url);
const port = Number(Deno.env.get("PORT") ?? "8787");

function contentType(pathname) {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".ico")) return "image/x-icon";
  if (pathname.endsWith(".woff2")) return "font/woff2";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

async function readStaticFile(pathname: string): Promise<Uint8Array | null> {
  const candidates = [new URL(`.${pathname}`, distRoot), new URL(`.${pathname}`, root)];

  for (const candidate of candidates) {
    try {
      return await Deno.readFile(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/sources") {
    return Response.json<AdminSourcesResponse>({
      sources: Object.values(notubizSources).map((source) => ({
        key: source.key,
        label: source.key.replaceAll("_", " "),
      })),
    });
  }

  if (url.pathname === "/api/admin/runs" && request.method === "GET") {
    try {
      const runs = await listRuns({
        sourceKey: url.searchParams.get("source") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? "50"),
      });
      return Response.json({ runs });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Runs ophalen mislukt" },
        { status: 500 },
      );
    }
  }

  if (url.pathname.startsWith("/api/admin/runs/") && request.method === "GET") {
    const runId = url.pathname.split("/").at(-1) ?? "";
    const details = await getRunDetails(runId);
    if (!details) {
      return Response.json({ error: "Run niet gevonden" }, { status: 404 });
    }
    return Response.json(details);
  }

  if (url.pathname === "/api/admin/rerun" && request.method === "POST") {
    try {
      const payload = (await request.json()) as AdminRerunRequest;
      if (!payload.sourceKey?.trim()) {
        return Response.json({ error: "Kies eerst een bron." }, { status: 400 });
      }
      if (!payload.dateFrom?.trim() || !payload.dateTo?.trim()) {
        return Response.json({ error: "Vul zowel een start- als einddatum in." }, { status: 400 });
      }
      if (payload.dateFrom > payload.dateTo) {
        return Response.json(
          { error: "De startdatum moet op of voor de einddatum liggen." },
          { status: 400 },
        );
      }
      const run = await startIngest(payload.sourceKey, payload.dateFrom, payload.dateTo, {
        ingestToQuickwit: true,
        trigger: "api",
      });
      return Response.json({ run });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Import mislukt" },
        { status: 500 },
      );
    }
  }

  if (url.pathname === "/api/search") {
    try {
      const results = await searchMeetings({
        query: url.searchParams.get("query") ?? "",
        organization: url.searchParams.get("organization") ?? "",
        entityType: url.searchParams.get("entityType") ?? "",
        sort: url.searchParams.get("sort") ?? "date_desc",
      });

      return Response.json<SearchResponse>({ results });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Zoeken mislukt",
        },
        { status: 500 },
      );
    }
  }

  if (url.pathname.startsWith("/api/entities/") && request.method === "GET") {
    const entityId = decodeURIComponent(url.pathname.replace("/api/entities/", ""));

    try {
      const content = await getEntityContent(entityId);
      if (!content) {
        return Response.json({ error: "Resultaat niet gevonden" }, { status: 404 });
      }
      return Response.json<EntityContentResponse>(content);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Documentinhoud ophalen mislukt",
        },
        { status: 500 },
      );
    }
  }

  const pathname =
    url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
  const file = await readStaticFile(pathname);

  if (file) {
    return new Response(file, {
      headers: {
        "content-type": contentType(pathname),
      },
    });
  }

  return new Response("Niet gevonden", { status: 404 });
});

console.log(`OpenBesluitvorming draait op http://127.0.0.1:${port}`);
