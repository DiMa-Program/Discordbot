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

- [x] T1 — `store.ts`: list every linked account; persist a per-user prompt decision
- [x] T2 — join handler with the one-time opt-in prompt
- [x] T3 — periodic sync with staggering, overlap protection and restart safety
- [x] T4 — `RANK_SYNC_INTERVAL_MINUTES` in config, default 720
- [x] T5 — tests for the store additions, the scheduler and the prompt decision logic
- [x] T6 — GitHub Actions renewal reminder
- [x] T7 — database backup in `npm run deploy`, before the upload, keeping a bounded history
- [x] T8 — README and `.env.example`

## Design decisions taken

1. **Prompt decisions live in their own table**, not as a column on `valorant_links`. A declined member
   has a decision and no link, and `unlinkAccount` deletes the whole row, so a column would either
   vanish on unlink or re-ask someone who deliberately left. `CREATE TABLE IF NOT EXISTS` is also
   additive where `ALTER TABLE ADD COLUMN` is not portable in SQLite.
2. **Staggering is a derived hash, never stored state.** `accountPhase` is FNV-1a over the user id and
   an account is due when its slot falls in the current window. Because the phase depends only on the
   id, there is no cursor or "last synced" column for a restart to lose, which is what makes a restart
   unable to storm the provider. Measured across a full cycle: 10 members land on 10 distinct minutes,
   150 on 136, each selected exactly once.
3. **One shared code path for role work.** `syncMemberRankRole` is used by both the `/menu` refresh and
   the periodic pass. Two copies of read-plans-apply are free to disagree about which stale role to
   remove, and disagreeing there is how a member ends up wearing two rank roles with nothing logged.
4. **The reminder uses a single open GitHub issue as its entire state machine.** No stored cursor: the
   job opens an issue, and the operator closes it after renewing. Daily cron only decides whether to
   act. It cannot live on the free instance, because that is exactly what dies when the reminder
   matters.
5. **A backup failure warns and continues.** The deploy does not touch `data/`, so blocking it on a
   backup would be a worse failure than the one it prevents.

## Verified after implementation

- `npm run typecheck` — exit 0
- `npm test` — 13 files, **310 tests passed** (was 244 across 11)
- `npm run build` — exit 0
- Migration 3 verified against a copy of the **real** `data/bot.db`: schema v2 to v3, the existing
  `valorant_links` row preserved, second `applyMigrations` returned `[]`. The original file untouched.

## Known gap found during verification

The database backup currently reports nothing on the host, and the reason is not in the code. SFTP
against this provider returns:

- `ls <directory>` for `data/` → error code 4, "failure"
- `get /home/container/data/` → `no such file`
- while `ls /home/container` lists `data` correctly

The directory demonstrably exists — the running bot reports `database: /home/container/data/bot.db`
and `ls` of the parent shows it. The `get` path fails on the trailing-slash form with an ambiguity
warning: *"selecting files using paths ending in / is ambiguous"*. The next step is a `get` without
the trailing slash, or a file-level `get` of the three known names. This is **not yet fixed**; the
backup step warns and the deploy proceeds, which is why nothing broke.

## Operator prerequisites

1. Developer Portal → Bot → Privileged Gateway Intents → **Server Members Intent** ON. Without it
   `guildMemberAdd` never arrives, so neither the greeting nor the prompt fires, and the sync pass
   reports an empty member cache and skips the guild.
2. `.env` on the host: `ENABLE_PRIVILEGED_INTENTS=true`. Optionally `RANK_SYNC_INTERVAL_MINUTES`
   (default 720; a blank value is a startup error, not "unset").
3. **Restart required.** No new slash commands, so `deploy:commands` does **not** need re-running.
4. Confirm from the log alone: `automatic rank sync scheduled` with `intervalMinutes`, `intervalMs`,
   `tickMinutes`, `concurrency` and `linkedAccounts`.

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
