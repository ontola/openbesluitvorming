import { getCatalogSourceByKey, getCatalogSourceByRef, listCatalogSources } from "./catalog.ts";
import type {
  AdminSourceOption,
  IbabsSourceDefinition,
  NotubizSourceDefinition,
  Supplier,
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

export function listAggregateRunnableSourceRefs(supplier?: Supplier): string[] {
  return listRunnableCatalogSources()
    .filter((source) => supplier ? source.supplier === supplier : true)
    .map((source) => source.sourceRef);
}

export function listAggregateAdminSourceOptions(): AdminSourceOption[] {
  const supplierLabels: Record<Supplier, string> = {
    notubiz: "Notubiz",
    ibabs: "iBabs",
    gemeenteoplossingen: "GemeenteOplossingen",
    parlaeus: "Parlaeus",
  };

  return [...new Set(listRunnableCatalogSources().map((source) => source.supplier))]
    .sort((left, right) => left.localeCompare(right, "nl"))
    .map((supplier) => ({
      key: `all_${supplier}`,
      sourceRef: `__supplier__:${supplier}`,
      label: `Alle ${supplierLabels[supplier]}-bronnen`,
      supplier,
      organizationType: "verzameling",
      implemented: true,
      isAggregate: true,
    }));
}

export function getSource(sourceKeyOrRef: string): SourceDefinition {
  const catalogSource = sourceKeyOrRef.includes(":")
    ? getCatalogSourceByRef(sourceKeyOrRef)
    : getCatalogSourceByKey(sourceKeyOrRef);

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
  const sourceOptions: AdminSourceOption[] = listCatalogSources().map((source) => ({
    key: source.key,
    sourceRef: source.sourceRef,
    label: source.label ?? source.key.replaceAll("_", " "),
    supplier: source.supplier,
    organizationType: source.organizationType,
    implemented: source.implemented,
  }));

  return [
    ...listAggregateAdminSourceOptions(),
    ...sourceOptions,
  ]
    .sort((left, right) => {
      if (!!left.isAggregate !== !!right.isAggregate) {
        return left.isAggregate ? -1 : 1;
      }
      if (left.implemented !== right.implemented) {
        return left.implemented ? -1 : 1;
      }
      return left.label.localeCompare(right.label, "nl");
    });
}
