import { runIngest } from "../src/ingest.ts";
import { getRunDetails, listRuns } from "../src/ops/store.ts";
import { notubizSources } from "../src/sources/notubiz.ts";
import { searchMeetings } from "./search_api.ts";

const root = new URL("./", import.meta.url);
const port = Number(Deno.env.get("PORT") ?? "8787");

function contentType(pathname) {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".json")) return "application/json; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "text/html; charset=utf-8";
}

Deno.serve({ port }, async (request) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/sources") {
    return Response.json({
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
      const payload = await request.json();
      const result = await runIngest(payload.sourceKey, payload.dateFrom, payload.dateTo, {
        ingestToQuickwit: true,
        trigger: "api",
      });
      return Response.json({ run: result.run });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Rerun mislukt" },
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

      return Response.json({ results });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Zoeken mislukt",
        },
        { status: 500 },
      );
    }
  }

  const pathname =
    url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
  const fileUrl = new URL(`.${pathname}`, root);

  try {
    const file = await Deno.readFile(fileUrl);
    return new Response(file, {
      headers: {
        "content-type": contentType(pathname),
      },
    });
  } catch {
    return new Response("Niet gevonden", { status: 404 });
  }
});

console.log(`OpenBesluitvorming draait op http://127.0.0.1:${port}`);
