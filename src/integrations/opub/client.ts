import { getConfigValue } from "../../config.ts";

const DEFAULT_OPUB_API_BASE = "https://opub.nl/api/v2";

export interface OpubIngestDocument {
  external_id: string;
  title: string;
  description?: string | null;
  content?: string | null;
  publication_date?: string | null;
  document_type?: string | null;
  category?: string | null;
  theme?: string | null;
  organisation?: string | null;
  metadata?: Record<string, unknown> | null;
  source?: string | null;
}

export interface OpubBatchResult {
  status?: string;
  created?: number;
  updated?: number;
  errors?: number;
  total?: number;
  details?: Array<Record<string, unknown>>;
}

export class OpubClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  static async fromEnvironment(): Promise<OpubClient> {
    const baseUrl = await getConfigValue("OPUB_API_BASE", DEFAULT_OPUB_API_BASE);
    const apiKey = await getConfigValue("OPUB_API_KEY");
    return new OpubClient(baseUrl.replace(/\/$/, ""), apiKey);
  }

  async ingestBatch(
    documents: OpubIngestDocument[],
    source?: string,
  ): Promise<OpubBatchResult> {
    const response = await fetch(`${this.baseUrl}/ingest/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-OPUB-API-KEY": this.apiKey,
      },
      body: JSON.stringify({
        documents,
        ...(source ? { source } : {}),
      }),
    });

    const body = await response.text();
    const payload = body ? JSON.parse(body) as OpubBatchResult & { error?: string } : {};

    if (!response.ok) {
      throw new Error(
        payload && typeof payload === "object" && "error" in payload && payload.error
          ? String(payload.error)
          : `OPub batch ingest failed (${response.status})`,
      );
    }

    return payload;
  }
}
