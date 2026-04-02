<script lang="ts">
  import { afterUpdate, createEventDispatcher, onDestroy, onMount } from "svelte";
  import type { AdminCoverageRow } from "../../src/types.ts";

  export let row: AdminCoverageRow;
  export let months: string[] = [];
  export let maxDocuments = 0;
  export let selectedRange: { startMonth: string; endMonth: string } | null = null;
  export let previewRange: { startMonth: string; endMonth: string } | null = null;
  export let anchorMonth = "";

  const dispatch = createEventDispatcher<{
    selectsource: { sourceKey: string };
    selectmonth: { sourceKey: string; month: string };
    hovermonth: { sourceKey: string; month: string };
    leave: { sourceKey: string };
  }>();

  const DEFAULT_HEIGHT = 24;

  let canvas: HTMLCanvasElement | null = null;
  let canvasHost: HTMLButtonElement | null = null;
  let hostWidth = 0;
  let tooltipVisible = false;
  let tooltipText = "";
  let tooltipLeft = 0;
  let palette = {
    empty: "#f7f9fc",
    low: "#dfeaff",
    high: "#1f5fc4",
    selectedFilled: "#1f5fc4",
    selectedEmpty: "#6da8ff",
    previewFilled: "#48cdb8",
    previewEmpty: "#b8f0e6",
    anchor: "#12957e",
  };

  let resizeObserver: ResizeObserver | null = null;

  function monthLabel(month: string): string {
    const date = new Date(`${month}T00:00:00Z`);
    return date.toLocaleDateString("nl-NL", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function coverageIntensity(documentCount: number): number {
    if (documentCount <= 0 || maxDocuments <= 0) return 0;
    const scaled = Math.log1p(documentCount) / Math.log1p(maxDocuments);
    return Math.max(0, Math.min(1, scaled ** 0.72));
  }

  function monthRangeContains(
    range: { startMonth: string; endMonth: string } | null,
    month: string,
  ): boolean {
    if (!range) return false;
    return month >= range.startMonth && month <= range.endMonth;
  }

  function parseRgb(value: string): [number, number, number] {
    const match = value.match(/\d+(\.\d+)?/g);
    if (!match || match.length < 3) {
      return [31, 95, 196];
    }
    return [Number(match[0]), Number(match[1]), Number(match[2])];
  }

  function interpolateColor(
    from: [number, number, number],
    to: [number, number, number],
    factor: number,
  ): string {
    const clamp = Math.max(0, Math.min(1, factor));
    const channel = (start: number, end: number) => Math.round(start + (end - start) * clamp);
    return `rgb(${channel(from[0], to[0])}, ${channel(from[1], to[1])}, ${channel(from[2], to[2])})`;
  }

  function colorForCell(month: string, documentCount: number): string {
    const inSelected = monthRangeContains(selectedRange, month);
    const inPreview = monthRangeContains(previewRange, month);

    if (inSelected) {
      return documentCount > 0 ? palette.selectedFilled : palette.selectedEmpty;
    }

    if (inPreview) {
      return documentCount > 0 ? palette.previewFilled : palette.previewEmpty;
    }

    if (documentCount <= 0) {
      return palette.empty;
    }

    return interpolateColor(
      parseRgb(palette.low),
      parseRgb(palette.high),
      coverageIntensity(documentCount),
    );
  }

  function draw(): void {
    if (!canvas || !canvasHost || months.length === 0 || hostWidth <= 0) {
      return;
    }

    const styles = getComputedStyle(canvasHost);
    palette = {
      empty: styles.getPropertyValue("--coverage-empty").trim() || "#f7f9fc",
      low: styles.getPropertyValue("--coverage-low").trim() || "#dfeaff",
      high: styles.getPropertyValue("--coverage-high").trim() || "#1f5fc4",
      selectedFilled: styles.getPropertyValue("--coverage-selected-filled").trim() || "#1f5fc4",
      selectedEmpty: styles.getPropertyValue("--coverage-selected-empty").trim() || "#6da8ff",
      previewFilled: styles.getPropertyValue("--coverage-preview-filled").trim() || "#48cdb8",
      previewEmpty: styles.getPropertyValue("--coverage-preview-empty").trim() || "#b8f0e6",
      anchor: styles.getPropertyValue("--coverage-anchor").trim() || "#12957e",
    };

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(hostWidth));
    const height = DEFAULT_HEIGHT;
    const cellWidth = width / months.length;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    for (let index = 0; index < months.length; index += 1) {
      const month = months[index];
      const cell = row.months[index];
      if (!cell) continue;

      const x = index * cellWidth;
      const drawX = Math.round(x);
      const nextX = index === months.length - 1
        ? width
        : Math.round((index + 1) * cellWidth);
      const drawWidth = Math.max(1, nextX - drawX);
      const drawY = 2;
      const drawHeight = height - 4;

      context.fillStyle = colorForCell(month, cell.documentCount);
      context.fillRect(drawX, drawY, drawWidth, drawHeight);

      if (anchorMonth === month) {
        context.strokeStyle = palette.anchor;
        context.lineWidth = 2;
        context.strokeRect(drawX + 1, drawY + 1, Math.max(1, drawWidth - 2), Math.max(1, drawHeight - 2));
      }
    }
  }

  function indexFromPointer(clientX: number): number {
    if (!canvasHost || months.length === 0) return -1;
    const rect = canvasHost.getBoundingClientRect();
    const x = clientX - rect.left;
    if (x < 0 || x > rect.width) return -1;
    const index = Math.floor((x / rect.width) * months.length);
    return Math.max(0, Math.min(months.length - 1, index));
  }

  function tooltipTextForIndex(index: number): string {
    const cell = row.months[index];
    const month = months[index];
    if (!cell || !month) return "";
    return `${monthLabel(month)} · ${cell.documentCount} ${cell.documentCount === 1 ? "document" : "documenten"}`;
  }

  function handlePointerMove(event: MouseEvent): void {
    const index = indexFromPointer(event.clientX);
    if (index < 0) {
      tooltipVisible = false;
      return;
    }

    const month = months[index];
    tooltipVisible = true;
    tooltipText = tooltipTextForIndex(index);
    tooltipLeft = ((index + 0.5) / months.length) * 100;
    dispatch("hovermonth", { sourceKey: row.sourceKey, month });
  }

  function handlePointerLeave(): void {
    tooltipVisible = false;
    dispatch("leave", { sourceKey: row.sourceKey });
  }

  function handleClick(event: MouseEvent): void {
    const index = indexFromPointer(event.clientX);
    if (index < 0) return;
    dispatch("selectmonth", { sourceKey: row.sourceKey, month: months[index] });
  }

  function handleSourceClick(): void {
    dispatch("selectsource", { sourceKey: row.sourceKey });
  }

  onMount(() => {
    if (canvasHost) {
      resizeObserver = new ResizeObserver((entries) => {
        hostWidth = entries[0]?.contentRect.width ?? 0;
        draw();
      });
      resizeObserver.observe(canvasHost);
      hostWidth = canvasHost.getBoundingClientRect().width;
      draw();
    }
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
  });

  afterUpdate(() => {
    draw();
  });
</script>

<article class="admin-coverage__row">
  <div class="admin-coverage__row-meta">
    <button type="button" class="admin-coverage__source-button" on:click={handleSourceClick}>
      <strong>
        {row.label}
        <span class="admin-coverage__count">{row.totalDocumentCount}</span>
      </strong>
    </button>
  </div>
  <button
    type="button"
    class="admin-coverage__canvas-host"
    bind:this={canvasHost}
    aria-label={`Selecteer periode voor ${row.label}`}
    on:mousemove={handlePointerMove}
    on:mouseleave={handlePointerLeave}
    on:click={handleClick}
  >
    <canvas bind:this={canvas} class="admin-coverage__canvas" height={DEFAULT_HEIGHT}></canvas>
    {#if tooltipVisible}
      <div class="admin-coverage__tooltip" style={`left:${tooltipLeft}%`}>
        {tooltipText}
      </div>
    {/if}
  </button>
</article>
