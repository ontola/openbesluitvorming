import type {
  AdminRerunRequest,
  AdminSourcesResponse,
  EntityContentResponse,
  SearchResponse,
} from "../src/types.ts";
import { startIngest } from "../src/ingest.ts";
import { getRunDetails, listRuns } from "../src/ops/store.ts";
import { listAdminSourceOptions, listRunnableSourceRefs } from "../src/sources/index.ts";
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
      sources: [
        {
          key: "__all__",
          sourceRef: "__all__",
          label: "Alle ondersteunde bronnen",
          supplier: "woozi",
          organizationType: "verzameling",
          implemented: true,
          isAggregate: true,
        },
        ...listAdminSourceOptions(),
      ],
    });
  }

  if (url.pathname === "/api/sources") {
    const implementedOnly = url.searchParams.get("implemented") === "true";
    const sources = listAdminSourceOptions().filter((source) =>
      implementedOnly ? source.implemented : true,
    );
    return Response.json<AdminSourcesResponse>({ sources });
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
      const sourceSelector = payload.sourceRef?.trim() || payload.sourceKey?.trim();
      if (!sourceSelector) {
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
      const sourceRefs = sourceSelector === "__all__" ? listRunnableSourceRefs() : [sourceSelector];
      const runs = await Promise.all(
        sourceRefs.map((sourceRef) =>
          startIngest(sourceRef, payload.dateFrom, payload.dateTo, {
            ingestToQuickwit: true,
            trigger: "user",
          }),
        ),
      );
      return Response.json({ runs });
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
        dateFrom: url.searchParams.get("dateFrom") ?? "",
        dateTo: url.searchParams.get("dateTo") ?? "",
        offset: Number(url.searchParams.get("offset") ?? "0"),
        limit: Number(url.searchParams.get("limit") ?? "24"),
      });

      return Response.json<SearchResponse>(results);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Zoeken mislukt",
        },
        { status: 500 },
      );
    }
  }

  if (
    url.pathname.startsWith("/api/entities/") &&
    url.pathname.endsWith("/pdf") &&
    request.method === "GET"
  ) {
    const entityId = decodeURIComponent(
      url.pathname.slice("/api/entities/".length, -"/pdf".length),
    );

    try {
      const content = await getEntityContent(entityId);
      if (!content?.pdfUrl) {
        return Response.json({ error: "PDF niet gevonden" }, { status: 404 });
      }

      const upstreamHeaders = new Headers();
      const range = request.headers.get("range");
      if (range) {
        upstreamHeaders.set("range", range);
      }

      const upstream = await fetch(content.pdfUrl, {
        headers: upstreamHeaders,
        redirect: "follow",
      });

      if (!upstream.ok && upstream.status !== 206) {
        return Response.json(
          { error: `PDF ophalen mislukt (${upstream.status})` },
          { status: 502 },
        );
      }

      const headers = new Headers();
      const contentType = upstream.headers.get("content-type") ?? "application/pdf";
      headers.set("content-type", contentType);

      const contentLength = upstream.headers.get("content-length");
      if (contentLength) {
        headers.set("content-length", contentLength);
      }

      const contentRange = upstream.headers.get("content-range");
      if (contentRange) {
        headers.set("content-range", contentRange);
      }

      const acceptRanges = upstream.headers.get("accept-ranges");
      headers.set("accept-ranges", acceptRanges ?? "bytes");
      headers.set("cache-control", "private, max-age=60");

      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "PDF ophalen mislukt",
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
