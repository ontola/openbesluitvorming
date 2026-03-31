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
- `Vote`
- `entity.commit`

Notes:

- `Document` is based on the current `MediaObject` / attachment shape.
- `Committee` is based on the current `Organization` usage for committees.
- `Vote` exists in the current ontology/model layer, even though it is not yet
  a major first-class output path in the pipeline.
- `entity.commit` is the first event schema and wraps these entity schemas in a
  CloudEvents-compatible envelope.
