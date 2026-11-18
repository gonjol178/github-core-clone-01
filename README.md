# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gonjol178/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gonjol178/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node 22 process, standard library only, that behaves like the slice of
GitHub the conformance suite exercises. Everything lives in memory in a
single store, so an object created through one surface is immediately the
same object on all the others.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — reference advertisement,
  protocol v2 `ls-refs` and `fetch` (with shallow/deepen), a v0 fetch
  fallback framed with side-band-64k, and v0 `git-receive-pack` with
  report-status. The object model, pack reader (ofs/ref deltas, thin packs)
  and pack writer (delta compression) are implemented from scratch on
  `node:crypto` SHA-1 and `node:zlib`; no git binary is involved.
- **REST v3** under `/api/v3` — repositories, branches, commits, the
  contents API backed by real git commits, labels, issues and comments,
  pull requests with file diffs and squash/merge/rebase merging. Every
  reply is JSON with an `X-GitHub-Request-Id` header.
- **GraphQL** at `/api/graphql` — a small hand-written parser and executor
  covering viewer/repository/issue/pull-request queries, connections with
  cursors, the five mutations the suite sends, batched operations, and
  introspection for the types it asks about.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, speaking the
  2026-07-28 revision via `server/discover` and the older `initialize`
  handshake, with six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Design notes

- The forge is single-tenant: the bearer token belongs to one account,
  whose login is derived deterministically from the contest's fixed
  scenario seed (see `lib/identity.ts`). Repositories addressed under any
  other owner answer 404, never 403.
- Identifiers are sequential counters and timestamps come from a logical
  clock seeded with the trial's opening time, so identical request
  sequences reproduce identical state.
- Pushes are fast-forward only; a refused ref reports
  `ng <ref> non-fast-forward` while its siblings still apply.
- Repeated depth-1 clones of an unchanged tip reuse cached pack bytes.

## Layout

- `main.ts` — lifecycle: bind an ephemeral port, register with the
  environment, poll for done, shut down.
- `app.ts` — HTTP routing and token checks.
- `lib/identity.ts` — the account the token belongs to.
- `lib/git.ts` — the git object model: commits, trees, tags, history.
- `lib/pack.ts` — packfiles and fetch planning (shallow, incremental).
- `lib/pktline.ts` — pkt-line framing.
- `lib/githttp.ts` — the git smart-HTTP protocol.
- `lib/store.ts` — the shared in-memory store and relay node ids.
- `lib/api.ts` — API serializers and shared operations (PR create/merge).
- `lib/rest.ts` — REST v3 routes.
- `lib/graphql.ts` — the GraphQL engine.
- `lib/mcp.ts` — the MCP endpoint and tools.

## Running

The environment runs the entry itself:

```
node main.ts
```

with `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` set. For a manual smoke
test, point those at any stub that accepts `POST /register` and answers
`GET /done`, then talk to the port the entry registered.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1k4fvxxj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
