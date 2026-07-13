import { getCatalogSourceByKey, getCatalogSourceByRef, listCatalogSources } from "./catalog.ts";
import type {
  AdminSourceOption,
  GemeenteOplossingenSourceDefinition,
  IbabsSourceDefinition,
  NotubizSourceDefinition,
  ParlaeusSourceDefinition,
  Supplier,
  SourceCatalogEntry,
  SourceDefinition,
} from "../types.ts";

const RUNNABLE_SUPPLIERS = new Set<Supplier>([
  "notubiz",
  "ibabs",
  "gemeenteoplossingen",
  "parlaeus",
]);

function isCatalogSourceRunnable(source: SourceCatalogEntry): boolean {
  return source.implemented;
}

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

  if (source.supplier === "ibabs") {
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

  if (source.supplier === "parlaeus") {
    return {
      key: source.key,
      label: source.label,
      supplier: "parlaeus",
      organizationType: source.organizationType,
      allmanakId: source.allmanakId,
      cbsId: source.cbsId,
      baseUrl: source.baseUrl!,
      sessionId: source.sessionId!,
    } satisfies ParlaeusSourceDefinition;
  }

  return {
    key: source.key,
    label: source.label,
    supplier: "gemeenteoplossingen",
    organizationType: source.organizationType,
    allmanakId: source.allmanakId,
    cbsId: source.cbsId,
    baseUrl: source.baseUrl!,
    apiVersion: "v1",
  } satisfies GemeenteOplossingenSourceDefinition;
}

function getImplementedCatalogSources(): SourceCatalogEntry[] {
  return listCatalogSources().filter(isCatalogSourceRunnable);
}

export function listRunnableCatalogSources(): SourceCatalogEntry[] {
  return getImplementedCatalogSources().filter((source) => RUNNABLE_SUPPLIERS.has(source.supplier));
}

export function listRunnableSourceRefs(): string[] {
  return listRunnableCatalogSources().map((source) => source.sourceRef);
}

export function listAggregateRunnableSourceRefs(supplier?: Supplier): string[] {
  return listRunnableCatalogSources()
    .filter((source) => (supplier ? source.supplier === supplier : true))
    .map((source) => source.sourceRef);
}

export function listAggregateAdminSourceOptions(): AdminSourceOption[] {
  const supplierLabels: Record<Supplier, string> = {
    notubiz: "Notubiz",
    ibabs: "iBabs",
    gemeenteoplossingen: "GemeenteOplossingen",
    parlaeus: "Parlaeus",
    allmanak: "Allmanak",
  };

  const catalog = listCatalogSources();
  const suppliers = [...new Set(catalog.map((source) => source.supplier))];

  return suppliers
    .sort((left, right) => left.localeCompare(right, "nl"))
    .map((supplier) => ({
      key: `all_${supplier}`,
      sourceRef: `__supplier__:${supplier}`,
      label: `Alle ${supplierLabels[supplier]}-bronnen`,
      supplier,
      organizationType: "verzameling",
      implemented: catalog.some((source) => source.supplier === supplier && source.implemented),
      isAggregate: true,
    }));
}

export function getSource(sourceKeyOrRef: string): SourceDefinition {
  const catalogSource = sourceKeyOrRef.includes(":")
    ? getCatalogSourceByRef(sourceKeyOrRef)
    : getCatalogSourceByKey(sourceKeyOrRef);

  if (!isCatalogSourceRunnable(catalogSource)) {
    throw new Error(`Unknown or unsupported source "${sourceKeyOrRef}"`);
  }

  if (!RUNNABLE_SUPPLIERS.has(catalogSource.supplier)) {
    throw new Error(
      `Source "${sourceKeyOrRef}" is present in the ORI catalog but not yet implemented in Woozi.`,
    );
  }

  return toRuntimeSourceDefinition(catalogSource);
}

/** getSource narrowed to Notubiz, for callers (mostly tests) that need the
 * supplier-specific definition. The catalog is the single source of truth. */
export function getNotubizSource(key: string): NotubizSourceDefinition {
  const source = getSource(key);
  if (source.supplier !== "notubiz") {
    throw new Error(`Source "${key}" is not a Notubiz source`);
  }
  return source;
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
    implemented: isCatalogSourceRunnable(source),
  }));

  return [...listAggregateAdminSourceOptions(), ...sourceOptions].sort((left, right) => {
    if (!!left.isAggregate !== !!right.isAggregate) {
      return left.isAggregate ? -1 : 1;
    }
    if (left.implemented !== right.implemented) {
      return left.implemented ? -1 : 1;
    }
    return left.label.localeCompare(right.label, "nl");
  });
}
