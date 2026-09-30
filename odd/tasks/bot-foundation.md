# Discord Bot Foundation

## Objective

Build an extensible Discord bot that can be installed into any server via OAuth2 with an explicit, least-privilege permission set, and to which new features can be added without touching core wiring.

## Problem

There is no code yet in this project. The user needs a working foundation: a bot that connects to the gateway, exposes commands and events through a registration mechanism, and ships with an install-link generator that requests only the permissions the feature set actually needs.

## Why

- The user wants to be able to add functions to the bot over time without a rewrite.
- Installing into arbitrary servers requires correct OAuth2 bitfield handling; requesting `Administrator` is a bad practice that Discord flags and that scares server owners.
- Privileged gateway intents are off by default, so event wiring has to be explicit and documented.

## Scope

IN:
- Node 24 + TypeScript + discord.js 14 project scaffold
- Environment/config validation (token, client id, guild id for dev)
- Discord client bootstrap with explicit, documented intents
- Feature/module registry: one folder = one feature with commands + event handlers
- Slash command loading and deployment (guild-scoped for dev, global for prod)
- OAuth2 install-link generator with least-privilege permission set
- Graceful shutdown and structured logging
- Vitest test setup with unit tests for pure logic (config, permissions, registry)
- README with setup steps and how to add a feature

OUT:
- Persistent database / storage backend
- Specific user-facing features (music, moderation, AI) — these get added later as modules
- Hosting / deployment pipeline
- Voice features

## Constraints

- Python is NOT installed on this machine; Node v24.21.0 and Go 1.27.0 are available. Node + TypeScript chosen for ecosystem maturity and least friction when adding features.
- Least-privilege permissions only. Never request `Administrator`.
- Privileged intents (MessageContent, GuildMembers, GuildPresences) must be enabled manually in the Developer Portal; the code must document this, not hide it.
- TypeScript strict mode. Artifacts in English.
- Secrets never committed; `.env.example` only, `.env` gitignored.

## Task list

- [x] T1 — Scaffold project: package.json, tsconfig, gitignore, env example, install dependencies
- [x] T2 — Config module: typed env parsing and validation with actionable errors
- [x] T3 — Logger + client bootstrap: explicit intents, ready/log/error handlers, graceful shutdown
- [x] T4 — Feature registry: loader that discovers feature folders and registers commands and event handlers
- [x] T5 — Slash command deployment script: guild-scoped (dev) and global (prod) targets
- [x] T6 — OAuth2 install link generator with least-privilege permission set
- [x] T7 — Ship one reference feature (`ping`) proving the extension path works end to end
- [x] T8 — Tests: vitest config plus unit tests for pure logic
- [x] T9 — README: setup, portal toggles, install link, how to add a feature

## Acceptance criteria

- `npm run typecheck` passes with zero errors under strict mode
- `npm test` passes
- `npm run build` produces a runnable `dist/index.js`
- A new feature can be added by creating one folder under `src/features/` with no edits to core files
- The install-link command prints a valid OAuth2 URL that requests only granular permissions
- README documents every manual Developer Portal toggle required

## Applicable checks

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run lint` if a linter is configured

## Delivery strategy

- `ask-on-risk` (default). Forecast below budget; no chaining expected.

## Route decisions

- T1 inline: mechanical install, no research needed.
- T2–T9 delegated to one writer: multiple non-trivial files sharing one design.

## Forecast

Estimated ~400 authored changed lines including tests and README. Around the planning heuristic; acceptable for a single foundation, no splitting planned.

## Progress

All nine tasks complete. The foundation runs with zero Developer Portal changes and installs requesting only `SendMessages` + `EmbedLinks` (bitfield `18432`).

## Verification evidence

Parent-verified (re-run independently after the writer returned, not taken on report):

- `npm run typecheck` — exit 0, clean under strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `npm test` — 4 files passed, 53 tests passed, exit 0
- `npm run build` — exit 0, `dist/index.js` produced
- `npm run invite` — prints a valid OAuth2 URL with `scope=bot+applications.commands&permissions=18432`
- Extension-path proof: created a throwaway `src/features/tempverify/` folder with ZERO core edits; `deploy-commands` discovered it (`count: 3`, commands `["ping","temp-verify","config-greeting"]`) and the consistency gate passed. Throwaway folder then deleted and the suite re-verified clean.

Versions confirmed live via `npm view`: discord.js 14.27.0, discord-api-types 0.38.56, zod 4.6.5, pino 10.3.1, vitest 5.0.3, tsx 4.23.15, dotenv 18.0.4. TypeScript pinned to `^5.9.0` (5.9.3 installed) rather than 7.x, since 7 is the freshly-rewritten native compiler.

Not verified end-to-end: live gateway login and a real slash-command deploy both require real credentials, which are absent by design. The deploy path was exercised up to the API boundary and returned `401` on a deliberately fake token, proving discovery and auth wiring without exposing secrets.

## Accepted design deviations from the original plan

- Privileged intents are opt-in **twice** (env flag AND feature declaration), not once. Safer default: the bot boots on the non-privileged set with no portal changes.
- Added a deployment consistency gate that was not in the original plan: two independent discovery paths must agree before commands are published, so a command can never deploy with no handler behind it.

## Known limitations

- Welcome-greeting state is in-memory and lost on restart. `greeting-store.ts` is the single swap point for a real database.
- Global slash command deploys can take up to an hour to propagate. Set `DISCORD_DEV_GUILD_ID` while developing.
- Shutdown deliberately does not call `process.exit` so buffered logs flush; `Client#destroy()` drains the event loop.
- No git repository exists yet, so no work-unit commits were made. Repository initialization is the user's decision.

## Next step

Fill in `.env` with real credentials, then `npm run invite` to install into a test server and `npm run dev` to bring the bot online.
