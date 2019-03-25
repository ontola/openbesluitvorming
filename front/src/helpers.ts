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
  const currentDocumentBase = params.get("showDocument");
  let currentDocument = null;
  if (currentDocumentBase !== null) {
    currentDocument = decodeURIComponent(currentDocumentBase);
  }
  let currentSearchTerm = params.get("searchbox");
  if (currentSearchTerm) {
    currentSearchTerm = currentSearchTerm.substr(1, currentSearchTerm.length - 2);
  }
  return {
    currentDocument,
    currentSearchTerm,
  };
};
