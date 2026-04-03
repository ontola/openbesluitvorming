#!/usr/bin/env python3
import sys
from pathlib import Path

import pymupdf
import pymupdf4llm


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


def fallback_markdown_with_pymupdf(input_path: Path) -> str:
    parts: list[str] = []
    with pymupdf.open(str(input_path)) as document:
        for index, page in enumerate(document):
            text = normalize_text(page.get_text("text"))
            heading = f"## Pagina {index + 1}"
            if text:
                parts.append(f"{heading}\n\n{text}")
            else:
                parts.append(heading)
    return "\n\n".join(parts).strip()


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: pymupdf4llm_extract.py <input.pdf> <output.md>", file=sys.stderr)
        return 2

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        markdown = pymupdf4llm.to_markdown(str(input_path))
    except Exception as error:
        print(
            f"pymupdf4llm failed, falling back to plain pymupdf extraction: {error}",
            file=sys.stderr,
        )
        markdown = fallback_markdown_with_pymupdf(input_path)
    output_path.write_text(markdown, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
