# Rank Auto-Sync and Hosting Safety

## Objective

Ask a member once, when they join, whether they want their VALORANT rank shown. Keep their rank role
current on a configurable schedule. Add a renewal reminder that survives the host, and back up the
database before every deploy.

## Problem

The user asked, at the very start, for roles to update automatically when someone connects to the
server. That was deferred during the rank-roles build and has never been delivered. Two further
concerns came out of the hosting work: the free tier can wipe instances, and it requires a manual
renewal every seven days that nobody should have to remember.

## Why

`guildMemberAdd` alone cannot satisfy "always up to date". It fires only when a member **joins**. A
member already in the server who climbs Diamond to Ascendant produces no event at all, which is why
join-only bots display stale ranks indefinitely. A periodic pass is the only mechanism that meets the
stated requirement.

## Scope

IN:
- One-time opt-in prompt on member join, with Yes/No buttons
- A Yes/No decision persisted per user so the prompt is never shown twice
- Periodic rank sync over linked members, interval configurable via `RANK_SYNC_INTERVAL_MINUTES`
- Staggered dispatch so the provider's per-minute request budget is never approached in a burst
- Renewal reminder as a scheduled GitHub Actions job that opens a GitHub issue
- Database download to a local folder before each deploy, keeping a bounded number of copies

OUT:
- DM channel fallback when a member has direct messages closed
- Deleting links for members who leave the guild
- Role icons (requires Server Boost level 2)
- Any automatic interaction with the hosting provider's panel

## Constraints

- All artifacts in English.
- Provider consent rules unchanged: only members who opted in are ever looked up.
- The reminder must not live on the free instance. If the server is suspended and deleted, anything
  hosted there goes with it, including a Discord webhook.
- The backup must run **before** the upload, so a failed deploy still leaves a copy.
- Strict TypeScript, NodeNext ESM with explicit `.js` extensions. Do not weaken tsconfig.
- Do not edit `package.json` dependencies, any `tsconfig*.json`, `src/features/ping/`, or
  `src/features/welcome/`.
- Do not commit. Leave everything in the working tree.

## Verified facts this design depends on

- `RANK_CACHE_TTL_MS = 300_000` in `src/features/ranks/provider.ts`. The free tier caches for five
  minutes, so polling faster than that cannot produce fresher data.
- Free tier budget is 30 requests per minute. Measured consumption at the user's scale is negligible:
  10 members every 12 hours is 0.05% of that budget.
- The bot currently uses 126 MB of the 715 MB free tier, so resource pressure is not a real
  constraint at this scale.
- `guildMemberAdd` requires the `GuildMembers` privileged intent, which is off until both the
  Developer Portal toggle and `ENABLE_PRIVILEGED_INTENTS=true` are set.
- HeavenCloud's own documentation states *"free instances can wipe"* and that a server suspended for
  non-renewal is *"deleted after 2 days"*. The database on that tier is not durable.
- The renewal is a panel action on a custom free tier, not a standard Pterodactyl feature, so it is not
  reachable from the Client API. It cannot be automated legitimately. The reminder can be.

## Design decisions to make

1. **Prompt channel.** Direct message is the cleanest, but it fails silently for members who have
   direct messages closed. Decide and document which failure behaviour is acceptable.
2. **Reminder state.** Prefer a mechanism that needs no stored state, so the user does not have to
   remember to acknowledge it.
3. **Sync trigger.** The scheduler must not run a second pass while a previous one is still going, and
   must survive a bot restart without storming the provider on boot.

## Task list

- [ ] T1 — `store.ts`: list every linked account; persist a per-user prompt decision
- [ ] T2 — join handler with the one-time opt-in prompt
- [ ] T3 — periodic sync with staggering, overlap protection and restart safety
- [ ] T4 — `RANK_SYNC_INTERVAL_MINUTES` in config, default 720
- [ ] T5 — tests for the store additions, the scheduler and the prompt decision logic
- [ ] T6 — GitHub Actions renewal reminder
- [ ] T7 — database backup in `npm run deploy`, before the upload, keeping a bounded history
- [ ] T8 — README and `.env.example`

## Acceptance criteria

- A member who joins is asked exactly once; declining is remembered and never re-asked
- A promotion is reflected within one configured interval without any user action
- A join and a periodic pass never run for the same member concurrently
- The provider request rate stays flat regardless of how many members are linked
- The reminder job runs on a schedule and does not require the bot, the PC, or the host to be up
- A database copy exists locally before any upload, and a failed deploy still produces a copy
- `npm run typecheck`, `npm test`, `npm run build` all pass

## Rollback boundary

Deleting `src/features/ranks/sync.ts` and the join handler removes the feature. The deploy backup and
the workflow are independent files and revert on their own.
