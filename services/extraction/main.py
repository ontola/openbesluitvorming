"""PDF extraction service: downloads PDF, extracts markdown, uploads to S3."""

import os
import tempfile
import time
from pathlib import Path

import boto3
import httpx
import pymupdf
import pymupdf4llm
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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


def get_s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_STORAGE_ENDPOINT"),
        region_name=os.environ.get("S3_STORAGE_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY"),
        aws_secret_access_key=os.environ.get("S3_SECRET_KEY"),
    )


class ExtractRequest(BaseModel):
    source_url: str
    s3_pdf_key: str
    s3_markdown_key: str | None = None
    s3_page_chunks_key: str | None = None
    max_pages: int = MAX_PAGES_DEFAULT


@app.post("/extract")
async def extract(req: ExtractRequest):
    global _requests_total, _requests_failed
    _requests_total += 1

    try:
        bucket = os.environ.get("S3_STORAGE_BUCKET_NAME", "woozi-dev")
        s3 = get_s3_client()

        # Download PDF from source
        t0 = time.monotonic()
        async with httpx.AsyncClient() as client:
            response = await client.get(req.source_url, follow_redirects=True, timeout=120)
            if response.status_code >= 400:
                return JSONResponse(
                    {"error": f"Source returned {response.status_code} for {req.source_url}"},
                    status_code=response.status_code,
                )
            pdf_bytes = response.content
        t_download = time.monotonic()

        with tempfile.TemporaryDirectory() as work_dir:
            pdf_path = Path(work_dir) / "document.pdf"
            pdf_path.write_bytes(pdf_bytes)

            with pymupdf.open(str(pdf_path)) as doc:
                page_count = doc.page_count

            pages = list(range(min(req.max_pages, page_count)))
            warnings: list[str] = []

            if page_count > req.max_pages:
                warnings.append(
                    f"Document has {page_count} pages; only the first {req.max_pages} were imported."
                )

            try:
                markdown = pymupdf4llm.to_markdown(str(pdf_path), pages=pages)
            except Exception as error:
                warnings.append(
                    f"pymupdf4llm failed, falling back to plain pymupdf extraction: {error}"
                )
                markdown = fallback_markdown_with_pymupdf(pdf_path, req.max_pages)

        t_extract = time.monotonic()

        # Upload PDF to S3
        s3.put_object(Bucket=bucket, Key=req.s3_pdf_key, Body=pdf_bytes,
                      ContentType="application/pdf")

        # Upload markdown to S3
        if req.s3_markdown_key and markdown:
            s3.put_object(Bucket=bucket, Key=req.s3_markdown_key,
                          Body=markdown.encode("utf-8"),
                          ContentType="text/markdown; charset=utf-8")

        t_upload = time.monotonic()

        print(f"[timing] dl={int((t_download-t0)*1000)}ms extract={int((t_extract-t_download)*1000)}ms upload={int((t_upload-t_extract)*1000)}ms pages={page_count} bytes={len(pdf_bytes)//1024}KB", flush=True)

        return JSONResponse({
            "markdown": markdown,
            "page_count": page_count,
            "warnings": warnings,
            "s3_pdf_url": f"{os.environ.get('S3_STORAGE_ENDPOINT', '')}/{bucket}/{req.s3_pdf_key}",
        })
    except Exception as error:
        _requests_failed += 1
        print(f"[error] {req.source_url}: {error}", flush=True)
        return JSONResponse(
            {"error": f"Extraction failed: {error}"},
            status_code=422,
        )


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
