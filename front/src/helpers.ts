import React from "react";
import { History } from "history";
import { NS } from "./LRS";

// Mapping for consistent component Ids
export const ids = {
  searchbox: "zoekterm",
  gemeenten: "gemeenten",
  daterange: "datums",
  type: "type",
};

export const capitalize = (s: string) => {
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const allComponentIds = Object.values(ids);

export function usePersistedState<T>(key: string, initial: T):
[T, React.Dispatch<React.SetStateAction<T>>] {

  const [value, setValue] = React.useState<T>(() => {
    const storageValue = sessionStorage.getItem(key);
    if (storageValue) {
      return JSON.parse(storageValue) || initial;
    }

    return initial;
  });

  const setPersistedValue = (next: T | React.SetStateAction<T>): void => {
    sessionStorage.setItem(key, JSON.stringify(next));
    setValue(next);
  };

  return [value, setPersistedValue];
}

export const getParams = (history: History) => {
  const searchObject = history.location.search;
  const params = new URLSearchParams(searchObject);

  const currentResourceBase = params.get("showResource");
  let currentResource = null;
  if (currentResourceBase !== null) {
    currentResource = decodeURIComponent(currentResourceBase);
  }

  let currentSearchTerm = params.get(ids.searchbox);
  if (currentSearchTerm) {
    currentSearchTerm = currentSearchTerm.substr(1, currentSearchTerm.length - 2);
  }
  return {
    currentResource,
    currentSearchTerm,
  };
};

// Turns ori_amsteram_215970157 into Amsterdam
export const indexToMunicipality = (_index: string) => {
  const parts = _index.split("_");
  return parts
    .slice(1, parts.length - 1)
    .map(s => `${s.charAt(0).toLocaleUpperCase()}${s.substring(1)}`)
    .join(" ");
};

// Sets the URL to the selected resource
export const openResource = (url :string, history: History) => {
  const currentURL = new URL(window.location.href);
  currentURL.searchParams.set("showResource", encodeURIComponent(url));
  history.push(currentURL.toString().substring(currentURL.origin.length));
};

// Turns MediaObject into Document
export const typeToLabel = (type: string) => {
  switch (type) {
    case "MediaObject":
      return "Document";
    case "AgendaItem":
      return "Agendapunt";
    case "Meeting":
      return "Vergadering";
    case "Membership":
      return "Lidmaatschap";
    case "Person":
      return "Persoon";
    case "CreativeWork":
      return "Stuk";
    case "Organization":
      return "Organisatie";
    default:
      return type || "Geen type";
  }
};

// Turns an RDF list in to a JS Array
export function listToArr(lrs: any, acc: any, rest: any) {
  if (Array.isArray(rest)) {
    return rest;
  }
  if (!rest || rest === NS.rdf("nil")) {
    return acc;
  }

  let first;
  if (rest.termType === "BlankNode") {
    const firstStatement = lrs.store.anyStatementMatching(rest, NS.rdf("first"));
    first = firstStatement && firstStatement.object;
  } else {
    first = lrs.getResourceProperty(rest, NS.rdf("first"));

    if (!first) {
      console.log("rest", rest);
      return lrs.getEntity(rest);
    }
  }
  acc.push(first);
  listToArr(lrs, acc, lrs.store.anyStatementMatching(rest, NS.rdf("rest")).object);

  return acc;
}

export function propertyToArr(lrs: any, acc: any, rest: any) {
  if (Array.isArray(rest)) {
    return rest;
  }
  if (typeof rest === "undefined" || rest === null) {
    return [];
  }
  if (Object.hasOwnProperty.call(rest, "termType") && rest.termType === "Literal") {
    return [rest];
  }

  return listToArr(lrs, acc, rest);
}
