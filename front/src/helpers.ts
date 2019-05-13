export const allComponentIds = [
  "searchbox",
  "gemeenten",
  "daterange",
  "type",
];

import React from "react";

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

import { History } from "history";

export const getParams = (history: History) => {
  const searchObject = history.location.search;
  const params = new URLSearchParams(searchObject);

  const currentResourceBase = params.get("showResource");
  // let currentResource = "https://id.openraadsinformatie.nl/243606";
  let currentResource = null;
  if (currentResourceBase !== null) {
    currentResource = decodeURIComponent(currentResourceBase);
  }

  let currentSearchTerm = params.get("searchbox");
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
