import React from "react";
import { NODE_ENV, SERVER_PORT } from "./config";

/** Mapping for consistent component Ids, used by reactivesearch */
export const ids = {
  searchbox: "zoekterm",
  organisaties: "organisaties",
  daterange: "datums",
  type: "type",
  tag: "thema",
  location: "locatie",
};

/** Returns an array of all identifiers */
export const allComponentIds = Object.values(ids);

/** Returns an array of all identifiers, except the one you pass */
export const allIdsBut = (id: string): string[] => {
  const allValues = Object.values(ids);
  const filteredValues = allValues.filter((value) => {
    return value !== id;
  });
  return filteredValues;
};

export const capitalize = (s: string) => {
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function usePersistedState<T>(
  key: string,
  initial: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
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

export function myPersistedState<T>(key: string, initial: T): T {
  const storageValue = sessionStorage.getItem(key);
  if (storageValue === null) {
    return initial;
  }
  return JSON.parse(storageValue);
}

export const getParams = (history: History) => {
  const searchObject = history.location.search;
  const hasParams = searchObject !== "";
  const params = new URLSearchParams(searchObject);

  const currentResourceBase = params.get("showResource");
  let currentResource = null;
  if (currentResourceBase !== null) {
    currentResource = decodeURIComponent(currentResourceBase);
  }

  let currentSearchTerm = params.get(ids.searchbox);
  if (currentSearchTerm) {
    currentSearchTerm = currentSearchTerm.substr(
      1,
      currentSearchTerm.length - 2
    );
  }

  let documentID = null;
  if (currentResource !== null) {
    documentID = currentResource.split("/")[3];
  }

  return {
    currentResource,
    currentSearchTerm,
    hasParams,
    documentID,
  };
};

// Turns ori_amsteram_215970157 into Amsterdam
// Should turn osi_utrecht into Provincie Utrecht
export const indexToLabel = (_index: string) => {
  const parts = _index.split("_");
  const stitchedName = parts
    .slice(1, parts.length - 1)
    .map((s) => `${s.charAt(0).toLocaleUpperCase()}${s.substring(1)}`)
    .join(" ");
  if (parts[0] === "osi") {
    return `Provincie ${stitchedName}`;
  }
  if (parts[0] === "ori") {
    return `Gemeente ${stitchedName}`;
  }
  if (parts[0] === "ggm") {
    return `Tweede Kamer`;
  }
  return stitchedName;
};

// Sets the URL to the selected resource
export const openResource = (url: string, history: History) => {
  console.log("open resource", url);
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

export const getApiURL = (): URL => {
  const url = new URL(window.location.origin);
  url.pathname = "/api";
  if (NODE_ENV === "development") {
    url.port = SERVER_PORT.toString();
  }
  return "https://api.openraadsinformatie.nl/v1/elastic";
  return url;
};

export const getTopicsApiURL = (relUrl: string): URL => {
  const url = new URL(window.location.origin);
  url.pathname = `/topics_api/dev${relUrl}`;
  if (NODE_ENV === "development") {
    url.port = SERVER_PORT.toString();
  }
  return url;
};

// Custom react hook for data fetching with error handling
export const useFetch = (url: string, options: RequestInit) => {
  const [response, setResponse] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(url, options);
        const json = await res.json();
        setResponse(json);
      } catch (error) {
        setError(error);
      }
    };
    fetchData();
  }, [url]);
  return { response, error };
};
