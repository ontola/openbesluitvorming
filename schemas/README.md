# Minimal Schemas

These schemas are the first contract-oriented extraction from the existing
ORI codebase.

They intentionally reuse current field names from:

- `ocd_backend/models/definitions/*.py`
- `ocd_backend/transformers/*.py`

They are minimal on purpose:

- strict on core identity and type
- permissive on optional legacy fields
- compatible with the current serialized JSON field names

Current scope:

- `Meeting`
- `Document`
- `Committee`
- `Motion`
- `Recording`
- `Vote` (shape only — see below)
- `entity.commit`

Notes:

- `Document` is based on the current `MediaObject` / attachment shape.
- `Committee` is based on the current `Organization` usage for committees.
- `Motion` covers moties/amendementen from iBabs list entries and Notubiz module
  items, including the outcome and — where the source publishes it — the
  per-member vote breakdown.
- `Recording` covers the video/audio registration of a meeting, plus the
  timeline that makes it navigable: chapters per agenda item, speaker segments,
  and the transcript where the supplier publishes one. The media bytes are
  never stored — a single two-day council meeting is ~10 GB — and the
  transcript itself lives in object storage rather than in the payload, for the
  same reason document markdown does.
- `Vote` exists in the current ontology/model layer but is not emitted as a
  standalone entity. Per-member votes live in `Motion.votes`, shaped after this
  schema, because a vote is only meaningful together with its motion. It is
  therefore absent from the `entity_type` enum in `entity.commit`, which lists
  only what an event can actually carry.
- `Party` and `Person` are emitted — a vote references both — but have no
  schema of their own yet. They are the fractie and the council member behind
  `Motion.votes[].group` and `.voter`.
- `entity.commit` is the first event schema and wraps these entity schemas in a
  CloudEvents-compatible envelope.
