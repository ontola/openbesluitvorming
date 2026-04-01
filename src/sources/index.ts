import { getCatalogSourceByRef, listCatalogSources } from "./catalog.ts";
import type {
  AdminSourceOption,
  IbabsSourceDefinition,
  NotubizSourceDefinition,
  SourceCatalogEntry,
  SourceDefinition,
} from "../types.ts";

function toRuntimeSourceDefinition(source: SourceCatalogEntry): SourceDefinition {
  if (source.supplier === "notubiz") {
    return {
      key: source.key,
      label: source.label,
      supplier: "notubiz",
      organizationType: source.organizationType,
      allmanakId: source.allmanakId,
      cbsId: source.cbsId,
      notubizOrganizationId: source.notubizOrganizationId!,
    } satisfies NotubizSourceDefinition;
  }

  return {
    key: source.key,
    label: source.label,
    supplier: "ibabs",
    organizationType: source.organizationType,
    allmanakId: source.allmanakId,
    cbsId: source.cbsId,
    ibabsSitename: source.ibabsSitename!,
  } satisfies IbabsSourceDefinition;
}

function getImplementedCatalogSources(): SourceCatalogEntry[] {
  return listCatalogSources().filter((source) => source.implemented);
}

export function listRunnableCatalogSources(): SourceCatalogEntry[] {
  return getImplementedCatalogSources().filter(
    (source) => source.supplier === "notubiz" || source.supplier === "ibabs",
  );
}

export function listRunnableSourceRefs(): string[] {
  return listRunnableCatalogSources().map((source) => source.sourceRef);
}

export function getSource(sourceKeyOrRef: string): SourceDefinition {
  const catalogSource = sourceKeyOrRef.includes(":")
    ? getCatalogSourceByRef(sourceKeyOrRef)
    : (() => {
        const matches = getImplementedCatalogSources().filter(
          (source) => source.key === sourceKeyOrRef,
        );
        if (matches.length === 0) {
          throw new Error(`Unknown source "${sourceKeyOrRef}"`);
        }
        if (matches.length > 1) {
          throw new Error(
            `Ambiguous source key "${sourceKeyOrRef}". Use the full source reference instead.`,
          );
        }
        return matches[0];
      })();

  if (!catalogSource.implemented) {
    throw new Error(`Unknown or unsupported source "${sourceKeyOrRef}"`);
  }

  if (catalogSource.supplier !== "notubiz" && catalogSource.supplier !== "ibabs") {
    throw new Error(
      `Source "${sourceKeyOrRef}" is present in the ORI catalog but not yet implemented in Woozi.`,
    );
  }

  return toRuntimeSourceDefinition(catalogSource);
}

export function listSources(): SourceDefinition[] {
  return listRunnableCatalogSources().map((source) => toRuntimeSourceDefinition(source));
}

export function listAdminSourceOptions(): AdminSourceOption[] {
  return listCatalogSources()
    .map((source) => ({
      key: source.key,
      sourceRef: source.sourceRef,
      label: source.label ?? source.key.replaceAll("_", " "),
      supplier: source.supplier,
      organizationType: source.organizationType,
      implemented: source.implemented,
    }))
    .sort((left, right) => {
      if (left.implemented !== right.implemented) {
        return left.implemented ? -1 : 1;
      }
      return left.label.localeCompare(right.label, "nl");
    });
}
