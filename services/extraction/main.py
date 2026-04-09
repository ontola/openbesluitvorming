"""Stateless PDF extraction HTTP service wrapping pymupdf4llm."""

import os
import tempfile
import time
from pathlib import Path

import pymupdf
import pymupdf4llm
from fastapi import FastAPI, UploadFile, File, Query
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_PAGES_DEFAULT = 40
_start_time = time.monotonic()
_requests_total = 0
_requests_failed = 0


def normalize_text(text: str) -> str:
    lines = [line.rstrip() for line in text.splitlines()]
    cleaned: list[str] = []
    blank_run = 0
    for line in lines:
        if line.strip():
            cleaned.append(line)
            blank_run = 0
        else:
            blank_run += 1
            if blank_run <= 1:
                cleaned.append("")
    return "\n".join(cleaned).strip()


def fallback_markdown_with_pymupdf(input_path: Path, max_pages: int) -> str:
    parts: list[str] = []
    with pymupdf.open(str(input_path)) as document:
        for index, page in enumerate(document):
            if index >= max_pages:
                break
            text = normalize_text(page.get_text("text"))
            heading = f"## Pagina {index + 1}"
            if text:
                parts.append(f"{heading}\n\n{text}")
            else:
                parts.append(heading)
    return "\n\n".join(parts).strip()


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    max_pages: int = Query(default=MAX_PAGES_DEFAULT),
):
    global _requests_total, _requests_failed
    _requests_total += 1
    pdf_bytes = await file.read()

    with tempfile.TemporaryDirectory() as work_dir:
        pdf_path = Path(work_dir) / "document.pdf"
        pdf_path.write_bytes(pdf_bytes)

        with pymupdf.open(str(pdf_path)) as doc:
            page_count = doc.page_count

        pages = list(range(min(max_pages, page_count)))
        warnings: list[str] = []

        if page_count > max_pages:
            warnings.append(
                f"Document has {page_count} pages; only the first {max_pages} were imported."
            )

        try:
            markdown = pymupdf4llm.to_markdown(str(pdf_path), pages=pages)
        except Exception as error:
            warnings.append(
                f"pymupdf4llm failed, falling back to plain pymupdf extraction: {error}"
            )
            markdown = fallback_markdown_with_pymupdf(pdf_path, max_pages)

    return JSONResponse({
        "markdown": markdown,
        "page_count": page_count,
        "warnings": warnings,
    })


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/stats")
async def stats():
    load_1, load_5, load_15 = os.getloadavg()
    return {
        "requests_total": _requests_total,
        "requests_failed": _requests_failed,
        "uptime_seconds": round(time.monotonic() - _start_time),
        "load_1m": round(load_1, 2),
        "load_5m": round(load_5, 2),
        "load_15m": round(load_15, 2),
    }
