import { currentProjectionVersion } from "../../pipeline/versioning.ts";
import { QuickwitClient } from "../../quickwit/client.ts";
import { listSources } from "../../sources/index.ts";
import { ObjectStorageClient } from "../../storage/s3.ts";
import { OpubClient, type OpubIngestDocument } from "./client.ts";

const QUICKWIT_PAGE_SIZE = 200;
const OPUB_BATCH_SIZE = 100;

type QuickwitDocumentHit = {
  entity_id?: string;
  name?: string;
  source_key?: string;
  start_date?: string;
  file_name?: string;
  content_type?: string;
  payload?: {
    original_url?: string;
    media_urls?: Array<{
      url?: string;
      original_url?: string;
      content_type?: string;
    }>;
    classification?: string[];
    md_text?: string[];
    derived_content?: {
      markdown_key?: string;
    };
  };
};

function usage(): never {
  console.error(
    "Usage: deno run -A src/integrations/opub/export.ts --source <sourceKey> --date-from <YYYY-MM-DD> --date-to <YYYY-MM-DD> [--dry-run] [--limit <n>]",
  );
  Deno.exit(1);
}

function parseArgs(args: string[]): {
  sourceKey: string;
  dateFrom: string;
  dateTo: string;
  dryRun: boolean;
  limit?: number;
} {
  let sourceKey = "";
  let dateFrom = "";
  let dateTo = "";
  let dryRun = false;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--source":
        sourceKey = args[++index] ?? "";
        break;
      case "--date-from":
        dateFrom = args[++index] ?? "";
        break;
      case "--date-to":
        dateTo = args[++index] ?? "";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--limit":
        limit = Number(args[++index] ?? "0");
        break;
      default:
        usage();
    }
  }

  if (!sourceKey || !dateFrom || !dateTo) {
    usage();
  }

  return {
    sourceKey,
    dateFrom,
    dateTo,
    dryRun,
    ...(limit && limit > 0 ? { limit } : {}),
  };
}

function normalizeDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10);
}

function withinDateRange(
  value: string | undefined,
  dateFrom: string,
  dateTo: string,
): boolean {
  if (!value) {
    return false;
  }
  return value >= dateFrom && value <= dateTo;
}

function documentDescription(markdown?: string): string | undefined {
  if (!markdown) {
    return undefined;
  }

  const compact = markdown
    .replaceAll(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  if (!compact) {
    return undefined;
  }

  return compact.length <= 320 ? compact : `${compact.slice(0, 317).trimEnd()}...`;
}

async function resolveMarkdown(
  storage: ObjectStorageClient,
  hit: QuickwitDocumentHit,
): Promise<string | undefined> {
  const inlineMarkdown = hit.payload?.md_text?.join("\n\n").trim();
  if (inlineMarkdown) {
    return inlineMarkdown;
  }

  const markdownKey = hit.payload?.derived_content?.markdown_key;
  if (!markdownKey) {
    return undefined;
  }

  const markdown = (await storage.getObjectText(markdownKey)).trim();
  return markdown || undefined;
}

function mapToOpubDocument(
  hit: QuickwitDocumentHit,
  markdown: string | undefined,
  organisationLabel: string,
): OpubIngestDocument | null {
  const externalId = hit.entity_id?.trim();
  const title = hit.name?.trim();
  if (!externalId || !title) {
    return null;
  }

  const media = hit.payload?.media_urls?.[0];
  const publicationDate = normalizeDate(hit.start_date);
  const classification = hit.payload?.classification?.[0];

  return {
    external_id: externalId,
    title,
    description: documentDescription(markdown) ?? null,
    content: markdown ?? null,
    publication_date: publicationDate ?? null,
    document_type: classification ?? null,
    category: null,
    theme: null,
    organisation: organisationLabel,
    source: "woozi",
    metadata: {
      source_key: hit.source_key,
      file_name: hit.file_name,
      content_type: media?.content_type ?? hit.content_type,
      original_url: media?.original_url ?? hit.payload?.original_url,
      download_url: media?.url ?? hit.payload?.original_url,
    },
  };
}

async function listDocumentsForSource(options: {
  sourceKey: string;
  dateFrom: string;
  dateTo: string;
  limit?: number;
}): Promise<QuickwitDocumentHit[]> {
  const quickwit = new QuickwitClient();
  const hits: QuickwitDocumentHit[] = [];
  let offset = 0;

  while (true) {
    const response = await quickwit.searchRequest({
      query:
        `projection_version:"${currentProjectionVersion()}" AND entity_type:Document AND source_key:${options.sourceKey}`,
      max_hits: QUICKWIT_PAGE_SIZE,
      start_offset: offset,
    });

    const pageHits = (response.hits as QuickwitDocumentHit[])
      .filter((hit) => withinDateRange(normalizeDate(hit.start_date), options.dateFrom, options.dateTo));
    hits.push(...pageHits);

    if (options.limit && hits.length >= options.limit) {
      return hits.slice(0, options.limit);
    }

    if (response.hits.length < QUICKWIT_PAGE_SIZE) {
      return hits;
    }

    offset += QUICKWIT_PAGE_SIZE;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  const source = listSources().find((item) => item.key === options.sourceKey);
  if (!source) {
    throw new Error(`Unknown or unsupported source "${options.sourceKey}"`);
  }

  const storage = await ObjectStorageClient.fromEnvironment();
  const opub = options.dryRun ? null : await OpubClient.fromEnvironment();

  const hits = await listDocumentsForSource(options);
  const documents: OpubIngestDocument[] = [];

  for (const hit of hits) {
    const markdown = await resolveMarkdown(storage, hit);
    const mapped = mapToOpubDocument(hit, markdown, source.label ?? source.key);
    if (mapped) {
      documents.push(mapped);
    }
  }

  const batches = chunk(documents, OPUB_BATCH_SIZE);
  const results = [];

  for (const [index, batch] of batches.entries()) {
    if (options.dryRun) {
      results.push({
        batch: index + 1,
        total: batch.length,
        status: "dry-run",
      });
      continue;
    }

    const result = await opub!.ingestBatch(batch, "woozi");
    results.push({
      batch: index + 1,
      total: batch.length,
      ...result,
    });
  }

  console.log(JSON.stringify({
    source: source.key,
    source_label: source.label ?? source.key,
    date_from: options.dateFrom,
    date_to: options.dateTo,
    dry_run: options.dryRun,
    documents_found: hits.length,
    documents_mapped: documents.length,
    batches: results,
  }, null, 2));
}
