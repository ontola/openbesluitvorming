/// <reference lib="dom" />

import type { AdminSourceOption } from "../../src/types.ts";

export interface SourcePickerConfig {
  input: HTMLInputElement;
  hiddenInput: HTMLInputElement;
  results: HTMLElement;
  options: AdminSourceOption[];
  valueSelector: (source: AdminSourceOption) => string;
  subtitle: (source: AdminSourceOption) => string;
  emptyMessage?: string;
}

export interface SourcePicker {
  setValue(value: string): void;
  getSelected(): AdminSourceOption | null;
  clear(): void;
}

export function createSourcePicker(config: SourcePickerConfig): SourcePicker {
  const {
    input,
    hiddenInput,
    results,
    options,
    valueSelector,
    subtitle,
    emptyMessage = "Geen bronnen gevonden.",
  } = config;
  const byLabel = new Map<string, AdminSourceOption>();

  for (const option of options) {
    byLabel.set(option.label, option);
  }

  function clearSelection(): void {
    hiddenInput.value = "";
  }

  function selectSource(source: AdminSourceOption): void {
    input.value = source.label;
    hiddenInput.value = valueSelector(source);
    results.hidden = true;
  }

  function render(query = ""): void {
    const normalizedQuery = query.trim().toLowerCase();
    results.replaceChildren();

    if (!normalizedQuery) {
      results.hidden = true;
      return;
    }

    const filtered = options.filter((source) =>
      [source.label, source.key, source.sourceRef, source.supplier, source.organizationType]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );

    if (filtered.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "source-picker__empty";
      emptyState.textContent = emptyMessage;
      results.appendChild(emptyState);
      results.hidden = false;
      return;
    }

    for (const source of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "source-picker__option";
      button.disabled = !source.implemented;
      button.innerHTML = `
        <strong>${source.label}</strong>
        <span>${subtitle(source)}</span>
      `;
      button.addEventListener("click", () => {
        if (!source.implemented) {
          return;
        }
        selectSource(source);
      });
      results.appendChild(button);
    }

    results.hidden = false;
  }

  input.addEventListener("input", () => {
    const selected = byLabel.get(input.value.trim());
    if (selected?.implemented) {
      hiddenInput.value = valueSelector(selected);
      results.hidden = true;
      return;
    }

    clearSelection();
    render(input.value);
  });

  input.addEventListener("focus", () => {
    render(input.value);
  });

  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      results.hidden = true;
    }, 120);
  });

  return {
    setValue(value: string): void {
      const selected = options.find((source) => valueSelector(source) === value);
      if (selected) {
        input.value = selected.label;
        hiddenInput.value = value;
      } else {
        input.value = "";
        hiddenInput.value = "";
      }
    },
    getSelected(): AdminSourceOption | null {
      return options.find((source) => valueSelector(source) === hiddenInput.value) ?? null;
    },
    clear(): void {
      input.value = "";
      hiddenInput.value = "";
      results.hidden = true;
    },
  };
}
