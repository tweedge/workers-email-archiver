# AGENTS.md

Guidance for coding agents working in this repository.

## Mission

`workers-email-archiver` is a Cloudflare Email Worker. It receives inbound mail
via Cloudflare Email Routing, gzip-compresses the raw message, and stores it at
an S3-compatible endpoint. Stability matters more than features: a missed
email is a failure, and a corrupted archive is worse than no archive.

## Hard rules

### Never read `.env` or any secret file

`.env` holds live Cloudflare credentials. **May never read it, print it, diff
it, `cat` it, or include it in any command output.** The same applies to
`.dev.vars`, `.env.*`, and anything under `~/.config/.wrangler/`.

- Do not `cat`, `head`, `tail`, `grep`, `sed`, `awk`, `xxd`, `base64`, or
  otherwise open these files.
- Do not run commands that would echo them, such as `env`, `printenv`, or
  `set` with secrets in scope. If you must inspect the environment, filter to
  the specific variable name and never print its value.
- Do not add them to git. `.env` is already covered by `.gitignore`; keep it
  that way. Never use `git add -f` on a secret file.
- Do not write secrets into `wrangler.toml`, `README.md`, tests, fixtures, or
  commit messages.
- If a task seems to require a secret value, ask the user to run the command
  or confirm the secret is configured instead of reading it.

`wrangler` itself loads `.env` automatically. You can run `npx wrangler whoami`,
`npx wrangler tail`, `npx wrangler deploy`, etc. **without reading the file** —
the CLI consumes the credentials directly. Treat the token as opaque: never
print it, log it, or interpolate it into a URL or command you display.

### Do not commit or push without being asked

Only commit, amend, push, or open a PR when the user explicitly requests it.

### `main` is branch-protected

Direct pushes to `main` are rejected (pull request + code scanning required).
Work on a branch and open a PR.

## Architecture

- `src/index.ts` — the entire Worker. `fetch` redirects to the project page;
  `email` reads and compresses the message, then hands it to the spool queue
  (or uploads inline when it cannot fit a queue message); `queue` uploads
  spooled messages to S3 with retries.
- `wrangler.toml` — Worker name, entrypoint, S3 endpoint/bucket/region vars,
  spool queue producer/consumer bindings, CPU limit, observability, smart
  placement. S3 credentials are Worker secrets, never in this file.
- `test/index.test.ts` — unit tests with the S3 endpoint mocked.
- `test/workers/runtime.test.ts` — integration tests in the real Workers
  runtime via `@cloudflare/vitest-plugin`.
- `.github/workflows/ci.yml` — format, typecheck, coverage, runtime tests,
  bundle check, dependency audit.
- `.github/workflows/deploy.yml` — deploys on push to `main`.

## Invariants to preserve

These are deliberate and covered by tests. Changing them is a behavior change
and needs the user's approval.

1. **Object key layout**: `<to-domain>/<encoded to-address>/<from-domain>/<epoch-ms>.eml.gz`,
   all lowercased, with key segments percent-encoded for SigV4 safety.
2. **SigV4 path safety**: `aws4fetch` decodes `+` as a space when building the
   canonical URI, so key segments must encode `+`, `=`, `%`, query/fragment
   delimiters, whitespace, and the RFC 3986 sub-delims `!'()*`. Any change must
   keep the signed canonical path equal to AWS's canonical URI.
3. **Size assertion**: the raw stream is read to completion and the byte count
   must equal `message.rawSize`. Never pre-allocate or zero-pad.
4. **Address parsing**: split on the **last** `@`; reject addresses with no
   usable domain rather than writing an `undefined` path segment.
5. **Bounded uploads**: one shared overall budget and a per-attempt timeout,
   clamped to the remaining budget. The email path uses 20s/8s, the queue
   consumer uses 30s/10s (it has a 15-minute wall limit). Retries cover 5xx,
   429, timeouts, and transport errors; other errors fail immediately.
6. **Early SMTP answer**: `email()` must return as soon as the message is
   durably spooled, never after a full upload attempt. Compressed payloads up
   to `MAX_QUEUED_PAYLOAD_BYTES` (120 KB, under the 128 KB queue limit) are
   sent to `ARCHIVE_QUEUE` and nothing else; only oversized payloads fall back
   to the inline upload. The queue `key` is generated once in `email()` so a
   consumer retry overwrites the same object rather than duplicating it.
7. **Compression**: native `CompressionStream('gzip')`, with the gzip header
   rewritten so `filename`/`mtime` are set to the archive timestamp and the
   FNAME flag is set. The deflate payload and CRC32/ISIZE trailer must be
   preserved untouched.

## Commands

```
npm ci                 # clean install
npm test               # unit + runtime tests
npm run test:unit      # unit tests only
npm run test:runtime   # workerd integration tests
npm run test:coverage  # enforce 100% coverage
npm run typecheck      # tsc for both configs
npm run format:check   # prettier
npm run build:check    # wrangler deploy --dry-run
npm run ci             # everything above, in order
```

Node >= 22.12.0 is required (wrangler v4).

## Working expectations

- Keep the worker minimal. Prefer fewer dependencies and less code.
- Add or update tests for every behavior change; coverage must stay at 100%.
- Run `npm run ci` before declaring work done.
- Do not add comments to code unless they explain non-obvious constraints.
- Keep secrets out of logs. If a command fails, report the error without
  echoing configuration values.
