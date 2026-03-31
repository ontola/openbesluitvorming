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

  if (url.pathname === "/api/search") {
    try {
      const results = await searchMeetings({
        query: url.searchParams.get("query") ?? "",
        organization: url.searchParams.get("organization") ?? "",
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

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
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
