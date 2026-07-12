#!/usr/bin/env python3
"""Scan legacy Open Raadsinformatie extracted-text files for BSN hits.

Intended to run on the ORI server against the document store:

    python3 scan_bsn_ori.py --root /opt/ori/data --out bsn-findings.ndjson

The file name stem of each ``.md``/``.metadata`` file is the resource ORI id
(the Elasticsearch ``_id``), so findings can be traced back to ES documents
directly. The scan is resumable via a state file, and findings contain only
masked digits, never a raw BSN.

Detection logic is a port of src/documents/bsn.ts (keep the two in sync):
elfproef validation, BSN-keyword proximity tiers, and exclusion of fiscal/bank
identifiers (BTW/VAT, RSIN, KvK, IBAN) plus digit-dense numeric tables.

Stdlib only; works on Python 3.6+.
"""

import argparse
import json
import os
import re
import sys
import time

KEYWORD_RE = re.compile(
    r"bsn|burger\s{0,2}service\s{0,2}nummer|sofi[\s-]{0,2}nummer|burgerservicenr|persoonsnummer",
    re.IGNORECASE,
)
CANDIDATE_RE = re.compile(u"\\d(?:[ . -]?\\d){6,11}")
EXCLUSION_BEFORE_RE = re.compile(
    r"(?:btw|vat|rsin|omzetbelasting|fiscaal|kvk|kamer\s+van\s+koophandel|iban"
    r"|rekeningnummer|bankrekening)[\s-]{0,3}(?:id|nr|no|nummer)?[^a-z]{0,20}(?:nl\s?)?$",
    re.IGNORECASE,
)
VAT_PREFIX_RE = re.compile(r"nl\s?$", re.IGNORECASE)
VAT_SUFFIX_RE = re.compile(r"^\s?b\s?\d{2}(?!\d)", re.IGNORECASE)
MASK_RUN_RE = re.compile(u"\\d(?:[ . -]?\\d){4,}")
KEYWORD_WINDOW = 120
EXCLUSION_WINDOW = 45
CONTEXT_RADIUS = 60
MIN_CONTEXT_ALPHA_RATIO = 0.25


def is_valid_bsn(value):
    digits = re.sub(r"\D", "", value)
    if len(digits) not in (8, 9):
        return False
    padded = digits.zfill(9)
    if padded == "000000000":
        return False
    total = sum(int(padded[i]) * (9 - i) for i in range(8)) - int(padded[8])
    return total % 11 == 0


def mask_digits(digits):
    if len(digits) <= 4:
        return "*" * len(digits)
    return digits[:2] + "*" * (len(digits) - 4) + digits[-2:]


def masked_context(text, index, length):
    start = max(0, index - CONTEXT_RADIUS)
    end = min(len(text), index + length + CONTEXT_RADIUS)
    snippet = text[start:end]
    snippet = MASK_RUN_RE.sub(lambda m: mask_digits(re.sub(r"\D", "", m.group(0))), snippet)
    return re.sub(r"\s+", " ", snippet).strip()


def mixed_token_ratio(text, index, length):
    """Fraction of context tokens mixing letters and digits (OCR-noise signal)."""
    start = max(0, index - CONTEXT_RADIUS)
    end = min(len(text), index + length + CONTEXT_RADIUS)
    tokens = [t for t in re.split(r"\s+", text[start:end]) if len(t) >= 3]
    if len(tokens) < 4:
        return 0.0
    mixed = sum(
        1 for t in tokens if any(c.isalpha() for c in t) and any(c.isdigit() for c in t)
    )
    return mixed / float(len(tokens))


def alpha_ratio(text, index, length):
    start = max(0, index - CONTEXT_RADIUS)
    end = min(len(text), index + length + CONTEXT_RADIUS)
    window = text[start:end]
    if not window:
        return 0.0
    letters = sum(1 for char in window if char.isalpha())
    return letters / float(len(window))


def scan_for_bsn(text):
    if not text:
        return {"found": False, "confidence": "none", "matches": []}

    keywords = [m.start() for m in KEYWORD_RE.finditer(text)]
    matches = []

    for candidate in CANDIDATE_RE.finditer(text):
        raw = candidate.group(0)
        index = candidate.start()

        before = text[index - 1] if index > 0 else ""
        after = text[index + len(raw)] if index + len(raw) < len(text) else ""
        before_before = text[index - 2] if index > 1 else ""
        after_after = (
            text[index + len(raw) + 1] if index + len(raw) + 1 < len(text) else ""
        )
        if before.isdigit() or after.isdigit():
            continue
        if before == "-" or (before in ".," and before_before.isdigit()):
            continue
        if after in ".," and after_after.isdigit():
            continue
        # Letter-glued numbers ("a52…59Q") are ids or OCR noise, never a BSN —
        # except directly after the keyword itself ("BSN123456782").
        if after.isalpha():
            continue
        if before.isalpha() and text[max(0, index - 3):index].lower() != "bsn":
            continue

        digits = re.sub(r"\D", "", raw)
        if len(digits) not in (8, 9):
            continue
        if not is_valid_bsn(digits):
            continue

        preceding = text[max(0, index - EXCLUSION_WINDOW):index]
        following = text[index + len(raw):index + len(raw) + 8]
        if (
            EXCLUSION_BEFORE_RE.search(preceding)
            or VAT_PREFIX_RE.search(preceding)
            or VAT_SUFFIX_RE.match(following)
        ):
            continue

        if mixed_token_ratio(text, index, len(raw)) > 0.3:
            continue

        near_keyword = any(abs(pos - index) <= KEYWORD_WINDOW for pos in keywords)
        is_plain_nine = len(digits) == 9 and raw == digits
        if not near_keyword and not is_plain_nine:
            continue
        if not near_keyword and alpha_ratio(text, index, len(raw)) < MIN_CONTEXT_ALPHA_RATIO:
            continue

        matches.append(
            {
                "masked": mask_digits(digits),
                "index": index,
                "digitCount": len(digits),
                "nearKeyword": near_keyword,
                "context": masked_context(text, index, len(raw)),
            }
        )

    if any(m["nearKeyword"] for m in matches):
        confidence = "high"
    elif matches:
        confidence = "medium"
    else:
        confidence = "none"
    return {"found": bool(matches), "confidence": confidence, "matches": matches}


def self_test():
    cases = [
        ("Naam: J. Jansen, BSN: 123456782, geboren te Utrecht.", "high"),
        ("Het dossier met nummer 111222333 is gesloten.", "medium"),
        ("burgerservicenummer 1234.56.782 van aanvrager", "high"),
        ("BSN 23456784 hoort bij de aanvraag", "high"),
        ("totaalbedrag 1234.56.782 in de begroting", "none"),
        ("factuurnummer 23456784 is betaald", "none"),
        ("totaal 123.456.782 euro subsidie", "none"),
        ("bel 0612345678 voor vragen", "none"),
        ("kenmerk 111222334 in het register", "none"),
        ("VAT/BTW-ID-Nr.: NL 123456782 B01 Directeur", "none"),
        ("RSIN: 123456782 van de stichting", "none"),
        ("KvK-nummer 123456782 te Rotterdam", "none"),
        ("meetwaarde -111222333 Kerkstraat", "none"),
        (
            "0,80 0,80 0,80 76 111222333 17 6,00 0,97 110,94 0 dB 0,80 0,80 152 48,10",
            "none",
        ),
        ("registratie S111222333 in het systeem", "none"),
        ("code 111222333x is toegekend", "none"),
        ("aanvrager met BSN111222333 is akkoord", "high"),
        (
            "ao85sd55 gogo39jj3e Sv3so3cjz0e2 Ssosj Zeo08 45 3 111222333 38 b5SToljzs 235 ds x53o gio53n0s5 oBoz2sc",
            "none",
        ),
    ]
    failed = 0
    for text, expected in cases:
        result = scan_for_bsn(text)
        if result["confidence"] != expected:
            failed += 1
            print(
                "FAIL: expected %s got %s for: %s" % (expected, result["confidence"], text)
            )
    if failed:
        sys.exit(1)
    print("selftest ok (%d cases)" % len(cases))


def iter_markdown_files(root):
    """Yields .md paths in deterministic lexicographic order (for resume)."""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if name.endswith(".md"):
                yield os.path.join(dirpath, name)


def load_state(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (IOError, OSError, ValueError):
        return {"after": "", "scanned": 0, "findings": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/opt/ori/data")
    parser.add_argument("--out", default="bsn-findings.ndjson")
    parser.add_argument("--state", default="bsn-scan-state.json")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        self_test()
        return

    state = load_state(args.state)
    after = state.get("after", "")
    if after:
        print("[resume] continuing after %s" % after)
    started = time.time()

    out = open(args.out, "a")
    try:
        for path in iter_markdown_files(args.root):
            if after and path <= after:
                continue
            try:
                with open(path, "rb") as handle:
                    text = handle.read().decode("utf-8", "replace")
            except (IOError, OSError) as error:
                print("[warning] read failed %s: %s" % (path, error))
                continue

            state["scanned"] = state.get("scanned", 0) + 1
            result = scan_for_bsn(text)
            if result["found"]:
                ori_id = os.path.splitext(os.path.basename(path))[0]
                record = {
                    "path": path,
                    "oriId": ori_id,
                    "confidence": result["confidence"],
                    "matches": result["matches"],
                    "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                out.write(json.dumps(record) + "\n")
                out.flush()
                state["findings"] = state.get("findings", 0) + 1
                print("[hit] %s %s" % (result["confidence"], path))

            state["after"] = path
            if state["scanned"] % 500 == 0:
                with open(args.state, "w") as handle:
                    json.dump(state, handle)
                rate = state["scanned"] / max(1.0, time.time() - started)
                print(
                    "[progress] scanned=%d hits=%d rate=%.1f/s"
                    % (state["scanned"], state.get("findings", 0), rate)
                )
            if args.limit and state["scanned"] >= args.limit:
                print("[stop] reached --limit %d" % args.limit)
                break
    finally:
        out.close()
        with open(args.state, "w") as handle:
            json.dump(state, handle)

    print(
        "[done] scanned=%d findings=%d output=%s"
        % (state.get("scanned", 0), state.get("findings", 0), args.out)
    )


if __name__ == "__main__":
    main()
