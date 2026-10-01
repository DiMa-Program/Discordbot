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

- [x] T1 — `config/env.ts`: optional `HENRIK_DEV_API_KEY`, validated as a non-empty string
- [x] T2 — `core/permissions.ts`: add `ManageRoles` to the install link; document the new bitfield
- [x] T3 — `features/ranks/tiers.ts`: 26-rank catalog with colors, normalized-name keys, tests
- [x] T4 — `features/ranks/regions.ts`: closed affinity union + tag-to-affinity inference, tests
- [x] T5 — `features/ranks/provider.ts`: `RankProvider` interface + `HenrikDevRankProvider`
- [x] T6 — `features/ranks/store.ts`: user → linked Riot ID, in-memory
- [x] T7 — `features/ranks/role-sync.ts`: idempotent role creation + remove-old/assign-new
- [x] T8 — `features/ranks/ui/`: `/menu` command, modal, buttons, embeds
- [x] T9 — unit tests for all pure logic
- [x] T10 — README: permission change, consent flow, boost caveat

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
- Tier catalog from `valorant-api.com/v1/competitivetiers`: 24 ranked steps + UNRANKED
- Discord Modals accept **only** `TextInput` components — no select menu inside a modal. This is why
  the link flow takes one text field and infers the region rather than offering a dropdown.

Parent-verified after implementation, not taken on report:

- `npm run typecheck` — exit 0
- `npm test` — 10 files passed, **186 tests passed** (baseline was 4 files / 62 tests)
- `npm run build` — exit 0
- Install link regenerated: `permissions=268453888`, listing `SendMessages`, `EmbedLinks`, `ManageRoles`
  and still explicitly not `Administrator` or `ManageGuild`

## Plan corrections made during implementation

1. **The ladder is 26 ranks, not 25.** The original plan said "24 ranked tiers + UNRANKED = 25" while
   listing 26 names. The 24 counts ranked *steps* (8 divisions × 3); Radiant is separate. Shipping 25
   would have left Radiant players with no role.
2. **`valorant-api.com/v1/competitivetiers` serves two different tables.** Its first entry is the
   pre-Ascendant `Episode1_CompetitiveTierDataTable`, where id 21 is `IMMORTAL 1` and Ascendant does
   not exist. The plan's original claim that id 24 was once `IMMORTAL 1` was wrong; the verified claim
   (21 was Immortal 1, now Ascendant 1) is the one kept. The two-tables problem is the stronger
   argument against id-based mapping and is what the module comment now cites.
3. **`default_member_permissions` does not gate buttons.** Discord honours it only on a slash-command
   payload or a row containing a select menu; `ActionRowBuilder` does not expose the setter for a
   button row. The create-roles action is therefore gated at runtime on `ManageGuild`. Setting the
   field on a button row would have been a no-op that reads as protection the user does not have.

## Two design bugs caught by the implementation's own tests

- `planRoleAssignment` originally stripped the old rank role even when the new one could not be
  granted (hierarchy violation, or the role does not exist). That leaves the member with no rank at
  all. A blocked plan now removes nothing.
- A failed member-role read degraded to `[]`, which made the sync grant the new role *without* removing
  the old one — and Discord renders the higher role, producing a silently wrong rank. It now refuses
  and reports instead.

## Deployment prerequisites for the operator

1. **Grant `ManageRoles`**: Server Settings → Roles → the bot's role → tick Manage Roles. No reinstall
   needed; the existing install bitfield only applies to new installs. The feature reads the
   permission live, so it takes effect on the next `/menu` without a restart.
2. **Run `npm run deploy:commands`** — `/menu` does not exist in Discord until deployed.
3. **The bot's role must sit above the rank roles.** `ensureRankRoles` creates them at the bottom of
   the hierarchy, which is normally correct; if the bot's role is dragged below them afterwards,
   assignment fails with a message naming the exact knob to turn.
4. If `HENRIK_DEV_API_KEY` is absent, `/menu` still works and explains the setup. A *blank* value is a
   startup config error rather than "off", deliberately, so a copy/paste that lost the value surfaces
   immediately instead of becoming a lookup that silently never works.

## Known limitations

- Links are in-memory and die on restart, matching `welcome/greeting-store.ts`.
- Ranks are cached by the provider for 300s on the free tier; the UI never claims live data.
- Roles match by exact name, so a hand-made `Gold 2` with a different colour is adopted rather than
  duplicated. Intentional for idempotency, but it means the catalog colour is not enforced on
  pre-existing roles.
- `npm test` does not typecheck. It can pass green while `tsc` reports errors, so both must run.
