# client/

Browser code that is **not** part of the site yet.

`site/` is the deploy source: publishing rsyncs from the working directory, so a
half-finished file under `site/assets/` reaches the public domain the moment
anyone syncs, committed or not. Staging here keeps unfinished browser code out
of that path. Move a file into `site/assets/` only in the same sitting as the
markup that calls it.

Nothing here is copied into the server image either — the Dockerfile takes only
`src/`, `package.json`, `package-lock.json` and `tsconfig.json`.

## pay.js

x402 payment from a browser wallet: connect, verify the challenge, sign an
EIP-3009 authorization, hand back the payload to attach to a retried MCP call.
Dependency-free, no build step. Tested in `test/pay.test.ts`.
