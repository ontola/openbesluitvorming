import type {
  AdminCoverageResponse,
  AdminRerunRequest,
  AdminRunSummaryResponse,
  AdminSourcesResponse,
  EntityContentResponse,
  SearchResponse,
} from "../src/types.ts";
import { startIngest } from "../src/ingest.ts";
import {
  getRunDetails,
  getRunSummary,
  listRuns,
  reconcileInterruptedRuns,
} from "../src/ops/store.ts";
import { listAdminSourceOptions, listAggregateRunnableSourceRefs } from "../src/sources/index.ts";
import type { Supplier } from "../src/types.ts";
import { getDocumentCoverage, getEntityContent, getIndexStats, searchMeetings } from "./search_api.ts";
import { ObjectStorageClient } from "../src/storage/s3.ts";

const root = new URL("./", import.meta.url);
const distRoot = new URL("./dist/", import.meta.url);
const projectRoot = new URL("../", import.meta.url);
const port = Number(Deno.env.get("PORT") ?? "8787");

const storage = await ObjectStorageClient.fromEnvironment();
const renderScriptPath = new URL("../scripts/pdf_render_page.sh", import.meta.url).pathname;

// Short-lived cache to deduplicate concurrent PDF downloads for the same document.
const pdfFetchCache = new Map<string, Promise<Uint8Array>>();

function pdfPageCacheKey(entityId: string, pageNumber: number): string {
  return `pdf-pages-v4/${entityId}/${pageNumber}.jpg`;
}

function pdfPageMetaKey(entityId: string): string {
  return `pdf-pages-v2/${entityId}/meta.json`;
}

function toResponseBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function cachedFetchPdf(pdfUrl: string): Promise<Uint8Array> {
  if (!pdfFetchCache.has(pdfUrl)) {
    const promise = fetch(pdfUrl, { redirect: "follow" })
      .then((r) => {
        if (!r.ok) throw new Error(`PDF ophalen mislukt: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => new Uint8Array(ab))
      .catch((err) => {
        pdfFetchCache.delete(pdfUrl);
        throw err;
      });
    pdfFetchCache.set(pdfUrl, promise);
    setTimeout(() => pdfFetchCache.delete(pdfUrl), 30_000);
  }
  return pdfFetchCache.get(pdfUrl)!;
}

const reconciledRuns = await reconcileInterruptedRuns();
if (reconciledRuns.length > 0) {
  console.warn(
    `Reconciled ${reconciledRuns.length} interrupted import${reconciledRuns.length === 1 ? "" : "s"} on startup.`,
  );
}
// Queued imports are handled by the worker process (src/worker.ts).

function contentType(pathname: string): string {
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

  if (url.pathname === "/API.md") {
    const file = await Deno.readFile(new URL("./API.md", projectRoot));
    return new Response(file, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const schemaMatch = url.pathname.match(/^\/schemas\/([\w.-]+\.schema\.json)$/);
  if (schemaMatch) {
    const file = await Deno.readFile(new URL(`./schemas/${schemaMatch[1]}`, projectRoot));
    return new Response(file, { headers: { "content-type": "application/schema+json; charset=utf-8" } });
  }

  if (url.pathname === "/api/admin/sources") {
    return Response.json<AdminSourcesResponse>({
      sources: [
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
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const runs = await listRuns({
        sourceKey: url.searchParams.get("source") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: limit + 1,
        offset,
      });
      return Response.json({
        runs: runs.slice(0, limit),
        hasMore: runs.length > limit,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Runs ophalen mislukt" },
        { status: 500 },
      );
    }
  }

  if (url.pathname === "/api/admin/summary" && request.method === "GET") {
    try {
      const summary = await getRunSummary();
      return Response.json<AdminRunSummaryResponse>({ summary });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Importsamenvatting ophalen mislukt" },
        { status: 500 },
      );
    }
  }

  if (url.pathname === "/api/admin/extractors" && request.method === "GET") {
    const raw = Deno.env.get("WOOZI_EXTRACTION_SERVICE_URL")?.trim() ?? "";
    const urls = raw ? raw.split(",").map((u) => u.trim()).filter(Boolean) : [];
    const workers = await Promise.all(
      urls.map(async (workerUrl) => {
        try {
          const response = await fetch(`${workerUrl}/stats`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const stats = await response.json();
          return { url: workerUrl, status: "ok" as const, ...stats };
        } catch {
          return { url: workerUrl, status: "unreachable" as const };
        }
      }),
    );
    return Response.json({ workers });
  }

  if (url.pathname === "/api/admin/coverage" && request.method === "GET") {
    try {
      const monthCount = Number(url.searchParams.get("months") ?? "12");
      const coverage = await getDocumentCoverage(monthCount);
      return Response.json<AdminCoverageResponse>(coverage);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Importdekking ophalen mislukt" },
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
      const executionMode = payload.executionMode ?? "full";
      if (sourceSelector.startsWith("__supplier__:") && executionMode !== "full") {
        return Response.json(
          { error: "Deze uitvoermodus is nog niet beschikbaar voor alle bronnen van een leverancier tegelijk." },
          { status: 400 },
        );
      }
      const sourceRefs = sourceSelector.startsWith("__supplier__:")
        ? listAggregateRunnableSourceRefs(sourceSelector.replace("__supplier__:", "") as Supplier)
        : [sourceSelector];
      const runs = await Promise.all(
        sourceRefs.map((sourceRef) =>
          startIngest(sourceRef, payload.dateFrom, payload.dateTo, {
            ingestToQuickwit: true,
            trigger: "user",
            executionMode,
            parentRunId: payload.parentRunId,
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

  if (url.pathname === "/api/stats") {
    try {
      const stats = await getIndexStats();
      return Response.json(stats, {
        headers: { "cache-control": "public, max-age=3600" },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Statistieken ophalen mislukt" },
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

  const pageRenderMatch = url.pathname.match(/^\/api\/entities\/([^/]+)\/pdf\/page\/(\d+)$/);
  if (pageRenderMatch && request.method === "GET") {
    const entityId = decodeURIComponent(pageRenderMatch[1]);
    const pageNumber = parseInt(pageRenderMatch[2], 10);

    if (isNaN(pageNumber) || pageNumber < 1) {
      return Response.json({ error: "Ongeldig paginanummer" }, { status: 400 });
    }

    const cacheKey = pdfPageCacheKey(entityId, pageNumber);
    const cached = await storage.getObjectBytes(cacheKey);
    if (cached) {
      const headers = new Headers({
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
      });
      const metadataText = await storage.getObjectText(pdfPageMetaKey(entityId)).catch(() => "");
      if (metadataText) {
        try {
          const metadata = JSON.parse(metadataText) as { page_count?: number };
          if (typeof metadata.page_count === "number" && metadata.page_count > 0) {
            headers.set("x-pdf-page-count", String(metadata.page_count));
          }
        } catch {
          // Ignore malformed cache metadata and serve the image bytes anyway.
        }
      }
      return new Response(toResponseBuffer(cached), {
        headers,
      });
    }

    try {
      const content = await getEntityContent(entityId);
      if (!content?.pdfUrl) {
        return Response.json({ error: "PDF niet gevonden" }, { status: 404 });
      }

      const pdfBytes = await cachedFetchPdf(content.pdfUrl);

      const command = new Deno.Command("sh", {
        args: [renderScriptPath, String(pageNumber)],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const process = command.spawn();
      const writer = process.stdin.getWriter();
      await writer.write(pdfBytes);
      await writer.close();
      const result = await process.output();

      if (!result.success) {
        const status = result.code === 1 ? 404 : 500;
        const msg = status === 404 ? "Pagina niet gevonden" : "PDF-pagina kon niet worden weergegeven";
        return Response.json({ error: msg }, { status });
      }

      const pageCount = parseInt(new TextDecoder().decode(result.stderr).trim(), 10);
      const imageBytes = result.stdout;

      await storage.putObject(cacheKey, imageBytes, { contentType: "image/jpeg" });
      if (!isNaN(pageCount) && pageCount > 0) {
        await storage.putObject(
          pdfPageMetaKey(entityId),
          new TextEncoder().encode(JSON.stringify({ page_count: pageCount })),
          { contentType: "application/json; charset=utf-8" },
        );
      }

      const headers = new Headers({
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
      });
      if (!isNaN(pageCount)) {
        headers.set("x-pdf-page-count", String(pageCount));
      }
      return new Response(imageBytes, { headers });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "PDF-pagina kon niet worden weergegeven" },
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
    return new Response(toResponseBuffer(file), {
      headers: {
        "content-type": contentType(pathname),
      },
    });
  }

  return new Response("Niet gevonden", { status: 404 });
});

console.log(`OpenBesluitvorming draait op http://127.0.0.1:${port}`);
