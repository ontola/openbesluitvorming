/** Which meetings an events page really contains.
 *
 * Notubiz lists two kinds of public event. A `meeting` is what it says. An
 * `assembly` is an evening with several meetings under it -- Castricum's
 * raadsplein model: one parent event, then carrousels, commissies and the
 * raadsvergadering as children -- and nearly every substantive document
 * hangs off an agenda item of a child. The events list carries the assembly
 * only; its children never appear there, and `events/meetings/{assembly}`
 * answers with the parent's own agenda and documents (the evening's agenda,
 * the besluitenlijst). So an import that took the events list at face value
 * got 88 documents for Castricum's whole 2023 instead of about 2,200 (#255),
 * and reported success.
 *
 * Every public event contributes its own id; an assembly contributes its
 * children's ids as well, read from `events/assemblies/{id}`. A failing
 * assembly lookup keeps the parent and reports the children as skipped
 * through `onAssemblyError`, so the hole is visible instead of silent. */
export interface AssemblyClient {
  getAssembly(assemblyId: number): Promise<unknown>;
}

export async function expandPublicMeetingIds(
  events: unknown[],
  client: AssemblyClient,
  onAssemblyError?: (assemblyId: number, error: unknown) => void | Promise<void>,
): Promise<number[]> {
  const ids: number[] = [];
  const seen = new Set<number>();
  const add = (id: unknown) => {
    if (typeof id === "number" && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.permission_group !== "public" || typeof record.id !== "number") {
      continue;
    }
    add(record.id);
    if (record.type !== "assembly") {
      continue;
    }
    try {
      const response = (await client.getAssembly(record.id)) as {
        assembly?: { meetings?: unknown[] };
      };
      for (const child of response.assembly?.meetings ?? []) {
        if (child && typeof child === "object") {
          add((child as Record<string, unknown>).id);
        }
      }
    } catch (error) {
      await onAssemblyError?.(record.id, error);
    }
  }
  return ids;
}
