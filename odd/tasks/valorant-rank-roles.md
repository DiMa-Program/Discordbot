# VALORANT Rank Roles Feature

## Objective

Add a Discord-native interface that links a user's VALORANT Riot ID, reads their competitive rank,
and keeps a rank role in sync on their profile — without asking anyone to type a command with
arguments.

## Problem

The user wants rank roles assigned automatically, and explicitly rejected `/vincular RiotID#TAG region`
style commands as tedious. They want an interface. They also want all 25 rank roles and all regions.

## Why

Rank display is only worth building if the friction is near zero. A user will link their account once;
every future rank check must cost them nothing. Discord modals and buttons are the right primitive —
they are native, need no custom frontend, and work inside the client the user is already in.

## Scope

IN:
- `/menu` as the single entry point, no arguments
- Button `[Vincular cuenta]` opens a **modal** with a single text field (Riot ID)
- Region is **inferred from the Riot ID tag** with automatic fallback across all affinities
- Button `[Actualizar rango]` fetches, renders an embed, and syncs the rank role
- Button `[Desvincular]` removes the stored Riot ID and any rank role
- Button `[Crear roles de rango]` creates the 25 roles with correct colors (idempotent)
- Rank roles keyed off **normalized tier name**, never tier id
- `RankProvider` interface so the data source is swappable in one line
- Runtime detection of missing `ManageRoles`, with an actionable message instead of a silent failure

OUT:
- Automatic sync on join (`guildMemberAdd`) — needs the privileged `GuildMembers` intent and does not
  detect promotions for members already present. Deferred; the provider interface does not block it.
- Periodic cron sync — deferred for the same reason, plus Discord role-change rate limits.
- Persistent storage — in-memory only for now, matching `welcome/greeting-store.ts`.
- Role icons on roles — requires Server Boost level 2. Out of our control.

## Constraints

- All artifacts in English.
- Provider terms **require explicit per-user consent**. The link flow is the consent capture and must
  be recorded, not implied.
- Never request `Administrator`.
- TypeScript strict + NodeNext ESM; relative imports need the `.js` extension.
- No edits to `tsconfig.json`, `package.json` or the foundation features.

## Verified facts this design depends on

All confirmed live, not assumed:

1. **Auth header is `Authorization`, not `X-API-Key`.** From the provider's OpenAPI spec
   (`api_key_header: { in: header, name: Authorization }`). `X-API-Key` returns 401 with a valid key.
2. **Endpoint**: `GET /valorant/v3/mmr/{affinity}/{platform}/{name}/{tag}`.
   Response `data.current.tier = { id, name }`, plus `rr`, `elo`, `games_needed_for_rating`, `last_change`.
3. **Valid affinities**: `na`, `latam`, `br`, `eu`, `ap`, `kr`. Rejected with error code 6:
   `pbe`, `las`, `la`, `oce`, `amer`. Latin America South is `latam`, **not** `LAS`.
4. **Tier ids are not stable.** Riot renumbered everything from `21` upward when Ascendant was added
   in Episode 6: id 21 was `IMMORTAL 1`, it is now `ASCENDANT 1`; id 24 is `RADIANT` but was
   `IMMORTAL 1`. Names are the only durable key.
5. **The live probe for `Dipplox#LPARG` / `latam` returned `Ascendant 2` (id 22), RR 32, Elo 1932.**
6. **Free tier caches responses for 300s**, so a promotion will not reflect instantly. The UI must not
   claim to be live.
7. **Riot's `na` shard also resolves LATAM and BR accounts**, which is the fallback that rescues
   South American users when their inferred region fails.

## Error codes that must map to distinct user-facing messages

| Code | Meaning | User-facing message |
|---|---|---|
| 6 | The region string we sent is invalid | Our bug; must never reach the user |
| 23 | Region valid, account has never played there | Wrong tag in the Riot ID |
| 25 | Region valid, account not in that shard | Retrying another region may fix it |
| 429 | Rate limited | Ask the user to retry shortly |

Code 6 is our fault. The provider must never be able to make the bot send one, so the affinity list is
a closed union validated before any request is spent.

## Task list

- [ ] T1 — `config/env.ts`: optional `HENRIK_DEV_API_KEY`, validated as a non-empty string
- [ ] T2 — `core/permissions.ts`: add `ManageRoles` to the install link; document the new bitfield
- [ ] T3 — `features/ranks/tiers.ts`: 25-rank catalog with colors, normalized-name keys, tests
- [ ] T4 — `features/ranks/regions.ts`: closed affinity union + tag-to-affinity inference, tests
- [ ] T5 — `features/ranks/provider.ts`: `RankProvider` interface + `HenrikDevRankProvider`
- [ ] T6 — `features/ranks/store.ts`: user → linked Riot ID, in-memory
- [ ] T7 — `features/ranks/role-sync.ts`: idempotent role creation + remove-old/assign-new
- [ ] T8 — `features/ranks/ui/`: `/menu` command, modal, buttons, embeds
- [ ] T9 — unit tests for all pure logic
- [ ] T10 — README: permission change, consent flow, boost caveat

## Acceptance criteria

- `npm run typecheck`, `npm test`, `npm run build` all pass
- `/menu` works with no arguments and shows state-aware buttons
- Linking takes exactly one text input; the user never picks a region from a list
- The correct rank role is applied and any previous rank role is removed
- Running the flow twice is idempotent — no duplicate roles, no errors
- A missing `ManageRoles` produces an actionable message, not a silent failure or a Discord 403 leak
- Swapping the provider requires changing one line and nothing else
- No tier mapping anywhere depends on a numeric tier id

## Risk: two `interactionCreate` listeners

`applyRegistry` binds both the command router and each feature's declared `handlers`. The ranks feature
needs its own `interactionCreate` handler for buttons and modals. The router returns early for
non-chat-input interactions, and the feature handler must return early for chat-input. They are
disjoint, but **this is the same class of bug that shipped a broken `/ping` earlier** — it must be
proven with a test, not assumed.

## Rollback boundary

Deleting `src/features/ranks/` removes the entire feature. The only core changes are the optional env
key and the `ManageRoles` bit in the install link, both independently revertible.

## Verification evidence

Parent-verified before implementation:

- Live lookup `Dipplox#LPARG` @ `latam` → Ascendant 2, RR 32, Elo 1932
- Affinity probe: `na`/`latam`/`br`/`eu`/`ap`/`kr` accepted; `pbe`/`las`/`la`/`oce`/`amer` code 6
- Tier catalog from `valorant-api.com/v1/competitivetiers`: 24 ranked tiers + UNRANKED
- Discord Modals accept **only** `TextInput` components — no select menu inside a modal. This is why
  the link flow takes one text field and infers the region rather than offering a dropdown.
