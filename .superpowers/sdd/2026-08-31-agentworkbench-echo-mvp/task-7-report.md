# Task 7 Report

## Fix Round 1

### RED

Command:

```text
node --test workbench/test/http-smoke.test.mjs
```

Observed before production fixes:

```text
1..4
# tests 4
# pass 2
# fail 2
not ok 2 - HTTP server rejects non-loopback host binding
  error: Missing expected rejection.
not ok 4 - served UI module is browser-safe without Node process or imports
  error: The input was expected to not match the regular expression /\bprocess\s*\./.
```

The SSE replay/reconnect regression passed against the existing polling cursor implementation; it remains as a real contract regression test.

### GREEN

Production changes:

- `startServer` rejects every host other than `127.0.0.1` before initialization or binding.
- Browser UI configuration uses `globalThis.__AWB_CONFIG` defaults instead of `process.env`/`process.cwd`.
- `openAgentsDir` no longer dynamically imports `node:child_process`; it displays a browser-safe message.
- HTTP smoke test removes its temporary workspace in `finally` and covers `since > 0` replay plus duplicate-free reconnect.

Focused command:

```text
node --test workbench/test/http-smoke.test.mjs
```

Exact result:

```text
1..4
# tests 4
# pass 4
# fail 0
```

Full required suite:

```text
node --test workbench/test/registry.test.mjs workbench/test/bus.test.mjs workbench/test/orchestrator.test.mjs workbench/test/replay.test.mjs workbench/test/verdict.test.mjs workbench/test/cli-smoke.test.mjs workbench/test/http-smoke.test.mjs
```

Exact result:

```text
1..28
# tests 28
# pass 28
# fail 0
# duration_ms 8896.7656
```

Syntax checks:

```text
node --check workbench/server/http.mjs
node --check workbench/server/sse.mjs
node --check workbench/ui/app.mjs
node --check workbench/test/http-smoke.test.mjs
```

All completed successfully with exit code 0.
