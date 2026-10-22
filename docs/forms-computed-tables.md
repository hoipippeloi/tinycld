# Forms: computed fields and tables

Two field kinds extend the forms engine: `computed` (a formula over other fields and table aggregates) and `table` (rows with typed columns, some computed). Hosts may declare `computed` and `table` built-ins.

- Evaluation uses a closed expression tree, not JSON Logic. Numbers coerce as: a number is itself, `true` is 1, anything else is 0. Division by zero is 0. Rounding is half away from zero, at the field's `decimals` (0 to 6).
- The server recomputes on every write and overwrites client-sent values.
- A value that reads a table missing from the write, or a skipped value, is left as it was; the rows' owner computes it.
- Cycles are rejected when a definition is saved.
- One JSON fixture (`core/lib/forms/fixtures/computed-fixture.json`) runs through the TypeScript and Go evaluators.
