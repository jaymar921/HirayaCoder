# /test

- `unit/` — pure logic tests (no `vscode` dependency), run with plain `mocha`.
- `integration/` — `@vscode/test-electron` suite exercising the real extension host.
- `fixtures/` — mock Ollama responses and sample workspace files for deterministic tests.
- `generated/` — output target for the Test Generator feature (never overwritten without a diff confirmation).

CI must run without network access — use `fixtures/` and a local mock Ollama server, never a live model.
