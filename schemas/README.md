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
- `Vote`
- `entity.commit`

Notes:

- `Document` is based on the current `MediaObject` / attachment shape.
- `Committee` is based on the current `Organization` usage for committees.
- `Motion` covers moties/amendementen from iBabs list entries and Notubiz module
  items, including the outcome and — where the source publishes it — the
  per-member vote breakdown.
- `Vote` exists in the current ontology/model layer but is not emitted as a
  standalone entity. Per-member votes live in `Motion.votes`, shaped after this
  schema, because a vote is only meaningful together with its motion.
- `entity.commit` is the first event schema and wraps these entity schemas in a
  CloudEvents-compatible envelope.
