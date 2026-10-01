# Discord bot foundation

An extensible discord.js bot that installs into any server through OAuth2 using an explicit,
least-privilege permission set, and grows by dropping a folder into `src/features/` — without
editing a single core file.

- **Least privilege by construction.** The install link requests only `SendMessages`, `EmbedLinks`
  and `ManageRoles`. `Administrator` and `Manage Server` are hard errors, not warnings.
- **Intents are explicit.** The bot runs with no Developer Portal changes. Privileged intents
  stay off until you ask for them, and only the ones a feature actually needs are requested.
- **Deploy-safe.** Command deployment refuses to publish if a command exists on disk but was
  never registered, so you cannot ship a command with no handler behind it.
- **Data survives a restart.** Links and per-server settings are stored in SQLite through Node's
  built-in `node:sqlite`. No new package, no native build step. See
  [Data and restarts](#data-and-restarts).

## Quick path

**Order matters: install first, deploy second.** Guild-scoped command registration requires the
application to be authorized in that guild with the `applications.commands` scope, and that only
happens during installation. Deploying to a guild the bot has not been installed into fails with
`404 Missing Access`.

1. Create a Discord application and bot (see [Create the application](#create-the-application)).
2. Copy `.env.example` to `.env` and fill in the token, application id and dev guild id.
3. `npm install`
4. `npm run invite` — prints the install link; open it, pick your server, approve.
5. `npm run deploy:commands` — registers the slash commands in that server.
6. `npm run dev` — start the bot, then type `/ping`.

Verify it worked: `/ping` replies `Pong! Gateway heartbeat: 0 ms.` in the channel you ran it
from.

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20.9 or newer | ESM only (`"type": "module"`). Node 24 recommended. |
| Discord account | — | Needed to create the application. |
| A Discord server | — | Your own test server is enough. |

Python is not required. Nothing is compiled to a native binary — the database is Node's built-in
`node:sqlite`, not a native addon, so `npm install` has no build step to fail.

## Create the application

1. Open the [Developer Portal](https://discord.com/developers/applications) and click
   **New Application**.
2. Name it and create it. You land on the **General Information** page.
3. Open the **Bot** tab and click **Add Bot**.
4. Leave **Privileged Gateway Intents** untouched for now — see the next section.

### Where the three values come from

| Value | Portal location | Shape |
|-------|-----------------|-------|
| `DISCORD_CLIENT_ID` | **General Information → Application ID** | 17–20 digit number. `Copy` sits next to the field. |
| `DISCORD_TOKEN` | **Bot → Reset Token** → **Copy** | Long mixed-case string. Shown once. Never commit it. |
| `DISCORD_DEV_GUILD_ID` | Discord itself, not the portal | Right-click your server → **Copy Server ID**. Needs **Settings → Advanced → Developer Mode**. |

## Configuration

The bot reads secrets from the environment, loading `.env` at startup. `.env` is gitignored and
`.env.example` is the only file you commit.

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `DISCORD_TOKEN` | yes | — | Bot token used to log in. |
| `DISCORD_CLIENT_ID` | yes | — | Application id. Used for command deployment and the install link. |
| `DISCORD_DEV_GUILD_ID` | no | *(unset)* | When set, commands deploy to that one server. When unset, they deploy **globally**. |
| `LOG_LEVEL` | no | `info` | One of `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. |
| `ENABLE_PRIVILEGED_INTENTS` | no | `false` | Opt in to the privileged intents features declare. See below. |
| `HENRIK_DEV_API_KEY` | no | *(unset)* | Key for the VALORANT rank provider. Unset means the ranks feature is inert: `/menu` still works and explains what is missing. Get one at [henrikdev.xyz](https://henrikdev.xyz/account). |
| `DATABASE_PATH` | no | `<project root>/data/bot.db` | Where the SQLite database lives. `:memory:` runs with no file at all. See [Data and restarts](#data-and-restarts). |

## Data and restarts

**Links and greeting settings are stored in SQLite, so they survive a restart, a redeploy and a
crash.** The bot adds **no new dependency**: it uses Node's built-in `node:sqlite`, so there is no
native module to build and nothing new in `package.json`.

| Question | Answer |
|----------|--------|
| Where is the file? | `<project root>/data/bot.db`, created on first run along with the `data/` directory. |
| Is it committed? | **No.** `data/` and `*.db` are gitignored. The file holds linked Riot IDs. |
| Can I move it? | Yes — set `DATABASE_PATH` to an absolute path. |
| Is the path relative to the code or to where I started the bot? | **The code.** It resolves from the module's own location, so a systemd unit or a `pm2` config that starts the bot from a different directory still opens the same file. A bot started from an unexpected working directory cannot silently create a second, empty database. |
| Can I throw the data away? | Delete `data/`, or set `DATABASE_PATH=:memory:`. |
| What if the schema changes? | Migrations run automatically at startup, in order, tracked by `PRAGMA user_version`. Starting the bot never drops or recreates a table. |

> **⚠️ Upgrading: every member must re-link their Riot ID once.**
>
> The old stores kept links in process memory, so there was no file to migrate from. **Nothing
> carries over.** After the first restart on this version, `/rank` will report that nobody has
> linked an account, and `/menu` will show the unlinked menu. That is a one-time action per member,
> not a bug — and it will not happen a second time. Greeting settings have the same caveat: run
> `/config-greeting` again in each server you had enabled it for.

If `ENABLE_PRIVILEGED_INTENTS` is not already in your `.env`, add it with the value `false`.
It is optional and that is the default.

`HENRIK_DEV_API_KEY` has one sharp edge: **delete the line entirely to turn the feature off.** A
blank value (`HENRIK_DEV_API_KEY=`) is reported as a configuration error, not treated as "no key",
because a copy/paste that lost the value would otherwise surface much later as a rank lookup that
silently never works.

Misconfiguration is reported in one pass, with the fix for each variable:

```
Invalid environment configuration:
  - DISCORD_TOKEN: is required
      Copy .env.example to .env, then paste the token from Discord Developer Portal > Bot > Reset Token.
  - DISCORD_CLIENT_ID: is required
      Copy the Application ID from Discord Developer Portal > General Information > Application ID.
```

## Privileged gateway intents

`Guilds` is always on. `GuildMessages` is on so message-driven features need no extra setup.
Neither requires a portal change.

Three intents are **privileged**: disabled in the portal by default, and requiring Discord
approval once your bot is in 75 or more servers. The bot never assumes them.

| Intent | Privileged | Needed by | Without it |
|--------|-----------|-----------|------------|
| `Guilds` | no | Everything | Bot cannot start. |
| `GuildMessages` | no | Message-driven features (none shipped) | `messageCreate` never fires. |
| `GuildMembers` | **yes** | `welcome` — `guildMemberAdd` | Greetings never fire. |
| `MessageContent` | **yes** | Reading user message text | `message.content` is empty. |
| `GuildPresences` | **yes** | Online/activity status | `presenceUpdate` never fires. |

A privileged intent is requested only when **both** conditions hold:

1. `ENABLE_PRIVILEGED_INTENTS=true` in `.env`, **and**
2. a feature declares it in `requiredIntents` (see `src/features/welcome/index.ts`).

Enabling only the portal toggle is not enough, and setting only the env var is not enough. When a
feature needs an intent it does not have, the bot says so at startup instead of failing silently:

```
WARN: feature declared gateway intents that are not enabled: its event handlers will never fire
      {"feature":"welcome","intents":"GuildMembers"}
WARN: set ENABLE_PRIVILEGED_INTENTS=true in .env AND tick the matching toggles in
      Discord Developer Portal > Bot > Privileged Gateway Intents
```

To enable one: **Bot → Privileged Gateway Intents**, tick **Server Members Intent**, save, then
set `ENABLE_PRIVILEGED_INTENTS=true` in `.env` and restart.

## Install into a server

```bash
npm run invite
```

```
Install this bot into a server by opening this URL:

  https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot+applications.commands&permissions=268453888

Requested channel permissions:
  - SendMessages — Reply to slash commands and post the opt-in welcome greeting.
  - EmbedLinks — Render command replies as rich embeds instead of plain text.
  - ManageRoles — Create the VALORANT rank roles and keep the correct one assigned to each member.

Deliberately not requested: Administrator, ManageGuild.
```

The script needs only `DISCORD_CLIENT_ID` — not the bot token — so you can produce the link
before the bot has ever run. Open the URL, choose a server, and approve. The consent screen
lists exactly the permissions above, so the server owner can see the scope before approving.

`permissions=268453888` is `SendMessages` (2048) `| EmbedLinks` (16384) `| ManageRoles`
(268435456). `applications.commands` in the scope list is what makes slash commands appear;
without it the bot installs and no command ever shows up.

**Managing permissions without reinstalling.** `/config-greeting` requires *Manage Server* from
the caller, but the bot is never installed with that permission. It is checked at runtime and
also declared as the command's `default_member_permissions`, so Discord hides the command from
members who cannot use it.

`ManageRoles` is different: it **is** requested at install time, because a server owner has to
approve it or the bot can never create the rank roles it exists to manage. You do not have to
reinstall to add it. Open **Server Settings → Roles**, click the bot's role, tick
**Manage Roles**, save. The feature reads the permission from the live guild on every use, so it
starts working on the next `/menu` without a restart. Removing it likewise takes effect
immediately, and the feature then says so instead of failing.

## VALORANT rank roles

`/menu` links a member's Riot ID, reads their competitive rank and keeps exactly one rank role on
them. It takes no arguments: everything happens through buttons and one text field.

`/rank` is the read. With no argument it shows your own rank; with `member:` it shows theirs, but
only if they have linked an account. Both replies are ephemeral.

### Quick path

1. Add `HENRIK_DEV_API_KEY` to `.env` and restart. Without it the feature is inert and `/menu`
   explains why.
2. Run `/menu` → **Create rank roles** (needs *Manage Server*). This creates all 26 roles, and is
   safe to run twice.
3. Run `/menu` → **Link account** → paste a Riot ID like `SomePlayer#EU1`.
4. The rank role is applied immediately. Use **Refresh rank** to re-check, or `/rank` to read it.

### `/rank`

| You run | You get |
|---------|---------|
| `/rank` | Your rank, from your own link. |
| `/rank member:@someone` | Their rank — but only if they linked an account. |
| `/rank member:@someone` and they never linked | A note saying so, and **no request is sent**. |

**It takes a member, never a Riot ID, and that is not an oversight.** A Riot ID option would let
anyone look up any player. The provider's terms do not support analytics a player has not consented
to, and Riot's policy does not allow exposing a player's data without opt-in — so the link *is* the
consent and there is deliberately no second way in. A test asserts the command's option shape, so a
string option cannot come back unnoticed.

The answer is **ephemeral**, including when you ask about somebody else: using the command on a
member is not a way to publish their rank to the channel. There is **no permission gate**, for the
same reason — reading a linked member's rank is public within the server, because linking already
agreed to it.

### What the user does, and what they never do

| Step | Who chooses it |
|------|----------------|
| Riot ID (`Name#TAG`) | The member. One text field. |
| Region | **Never asked.** Inferred from the tag, then retried across the other shards. |
| Whether the bot reads their rank | The member, by pressing **Link account**. |

That last row is the consent capture, and it is a real one: a Riot ID is written to storage only
inside the modal submit handler, and only after a lookup succeeds. **Unlink** deletes it.

A region dropdown is not an option because **Discord modals accept only text inputs** — no select
menu can be placed inside one. Inference is allowed to be wrong: the tag picks the first shard, then
every other affinity is tried in turn, and Riot's `na` shard also resolves LATAM and BR accounts,
which is what rescues a South American player whose tag does not match.

### Things that will look like bugs but are not

| Behaviour | Why |
|-----------|-----|
| A promotion takes a few minutes to show | The free tier caches responses for **300 seconds**. The UI never claims the data is live. |
| `/rank` answered from a cache, with no request | A rank younger than **300 seconds** is already stored, so re-running the command costs nothing against the 30-requests-per-minute free tier. The answer says it was cached, so it never reads as a live one. |
| Ranks are named `Ascendant 2`, not `ASCENDANT 2` | Tiers are matched on the **normalised name**, never on Riot's tier id. Riot renumbered every id from 21 up when Ascendant arrived, so an id-based mapping silently assigns the wrong role. A test scans the source to keep it that way. |
| Roles have plain colours, no icons | Role icons require **Server Boost level 2**. Out of our control. |
| Only the highest rank role is ever held | Discord renders one role's colour, not a blend. The old role is always removed in the same operation that grants the new one. |

### The `ManageRoles` bit

The feature needs *Manage Roles* on the bot. See
[Managing permissions without reinstalling](#install-into-a-server) — it takes effect immediately,
no reinstall.

Two failure modes are detected before Discord can produce an opaque 403, and each gets its own
message:

- **No `Manage Roles`** — read from the live guild on every use, never assumed from the install
  bitfield, because the permission can be revoked afterwards.
- **Role hierarchy** — Discord will not let a bot assign a role at or above its own. If that is the
  problem, the message says to move the bot's role higher in *Server Settings → Roles*.

Both leave the member's existing role untouched, rather than stripping it and leaving them with
nothing.

### Not included

- **Automatic sync on join** needs the privileged `GuildMembers` intent and does not detect
  promotions for members who are already in the server. Deferred; the provider interface does not
  block it.
- **Periodic re-sync** is deferred for the same reason, plus Discord's role-change rate limits.
- **A different rank provider** is one class with one method (`RankProvider`), constructed in a
  single place: `src/features/ranks/context.ts`.

Deleting `src/features/ranks/` removes the entire feature. The only core changes it depends on are
the optional env key and the `ManageRoles` bit, and both revert independently.

## Add a new feature

A feature is one folder. No core file changes, no registration step, no import to add.

**1. Write the command.** Create `src/features/streak/commands/streak.ts`:

```ts
import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('streak')
  .setDescription('Show the current streak.')
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: 'Your streak is 0 days.' });
}
```

**2. Declare the feature.** Create `src/features/streak/index.ts`:

```ts
import type { Feature } from '../../core/registry.js';
import { data, execute } from './commands/streak.js';

export default {
  name: 'streak',
  description: 'Daily activity streaks.',
  commands: [{ data, execute }],
} satisfies Feature;
```

**3. Deploy and run.**

```bash
npm run deploy:commands
npm run dev
```

That is the whole extension path. The registry discovers `src/features/*/index.ts` at boot, so
restarting is all it takes to pick the feature up.

### Optional: reacting to events

Add `handlers/<event>.ts` and reference it. The handler is type-checked against the event it is
bound to, so a wrong parameter is a compile error.

```ts
// src/features/streak/handlers/member-join.ts
import type { GuildMember } from 'discord.js';

export async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
  // ...
}
```

```ts
export default {
  name: 'streak',
  commands: [{ data, execute }],
  handlers: { guildMemberAdd: handleGuildMemberAdd },
  requiredIntents: [GatewayIntentBits.GuildMembers], // only if you need one
} satisfies Feature;
```

A privileged intent in `requiredIntents` is still only requested when
`ENABLE_PRIVILEGED_INTENTS=true`, and the registry warns at boot if it is unavailable.

### Optional: shared state

Anything a feature must remember between commands needs a table. A module-scoped `Map` is no longer
enough: it dies with the process, which is the bug that made every member relink after each deploy.
Both shipped features show the pattern — a store module in the feature folder that reads and writes
through `src/core/db.ts` and keeps its own row mapper:

```ts
// src/features/streak/streak-store.ts
import { getDatabase, requireNumber } from '../../core/db.js';

const TABLE = 'streaks';

export function currentStreak(userId: string): number {
  const row = getDatabase().prepare(`SELECT days FROM ${TABLE} WHERE user_id = ?`).get(userId);
  return row === undefined ? 0 : requireNumber(row, TABLE, 'days');
}
```

| Rule | Why |
|------|-----|
| Depend on the `Database` interface, never on `node:sqlite` types | Nothing outside `core/db.ts` names the driver, so it stays swappable. |
| Map every row to your own type at the boundary | `node:sqlite` returns loose values. `requireNumber` and friends keep `unknown` out of feature code. |
| Make optional columns nullable, and read `null` back as `null` | A `null` read as `0` would tell a member their rank is zero. |
| Add a new table as a **new** migration version | Never renumber an applied one, or a deployed database ends up with a schema its own version marker does not describe. |
| Keep the store's public API synchronous | `node:sqlite` is synchronous, so a read costs the same as the `Map.get` it replaced. |

`src/features/*/commands/` files are scanned for deployment, so a shared helper belongs in the
feature root, not in `commands/`.

### The two discovery paths

| Path | Reads | Used by |
|------|-------|---------|
| `src/features/*/index.ts` | the `commands` and `handlers` arrays | the running bot |
| `src/features/*/commands/**/*.ts` | every file exporting `data` + `execute` | command deployment |

They must agree. `npm run deploy:commands` compares them and publishes nothing if they diverge:

```
ERROR: feature manifests and the commands/ tree disagree: nothing was deployed
```

This is why step 2 is not optional: a command file that no manifest lists would otherwise be
deployed with no handler behind it.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the bot with reload on change. |
| `npm run build` | Compile to `dist/`. |
| `npm start` | Run the compiled `dist/index.js`. |
| `npm run typecheck` | `tsc --noEmit` over `src/`, strict. |
| `npm test` | Vitest unit tests. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run deploy:commands` | Bulk-overwrite slash commands. Guild-scoped if `DISCORD_DEV_GUILD_ID` is set, global otherwise. |
| `npm run invite` | Print the OAuth2 install link. |

**Command deployment is a bulk overwrite.** It reconciles the remote set with the local one, so
deleting a command file removes it from Discord instead of leaving it there forever. Guild-scoped
commands appear in about a second; global ones can take up to an hour to propagate.

## Project layout

```
src/
  index.ts                     entrypoint: load env, open database, build client, login
  config/env.ts                pure validation; no process.env at import time
  core/db.ts                   the ONLY module that imports node:sqlite; handle + migrations
  core/logger.ts               pino root + child logger, redacts credentials
  core/permissions.ts          permission set and invite-URL builder (no client needed)
  core/registry.ts             feature discovery, wiring plan, command routing and collection
  client/bot.ts                client construction, intents, diagnostics, shutdown
  scripts/deploy-commands.ts   slash command deployment
  scripts/print-invite.ts      install-link generator
  features/
    ping/                      reference feature: one command
    welcome/                   reference feature: one event handler + toggle command
    ranks/                     VALORANT rank roles: /menu, /rank, modal, buttons, provider, role sync
```

Pure logic is separated from discord.js objects on purpose: `permissions.ts`, `registry.ts` and
`env.ts` are all testable without a client, a token or a `.env` file. The ranks feature keeps the
same split inside its folder — `tiers.ts`, `regions.ts` and `role-sync.ts` hold the rules, and only
`interaction.ts` and the discord.js gateway adapter touch the library.

`core/db.ts` is the one place that imports `node:sqlite`, which is what keeps the driver swappable
and lets the whole suite run against `:memory:`. Each feature owns its own table and its own row
mapper (`valorant_links` in `ranks/store.ts`, `welcome_settings` in `welcome/greeting-store.ts`),
while the ordered, versioned migration list lives beside the handle it applies to.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Invalid environment configuration` | No `.env`, or a variable is blank | Copy `.env.example` to `.env` and fill it in. |
| `401: Unauthorized` when deploying | Wrong or expired `DISCORD_TOKEN` | **Bot → Reset Token**, update `.env`. |
| `401: Unauthorized` when deploying | Token belongs to a different application | Check the app id matches `DISCORD_CLIENT_ID`. |
| Commands missing from the picker | Commands were never deployed, or deployed before installing | Install first (step 4), then run `npm run deploy:commands`. Guild registration returns `404 Missing Access` when the app is not authorized in the guild. |
| `404 Missing Access` when deploying | Deploying to a guild before installing there | Install into the server with the invite link, then deploy. |
| Commands missing globally | Global propagation delay | Set `DISCORD_DEV_GUILD_ID` to develop against one server instead. |
| Bot installed but no commands at all | `applications.commands` scope missing | Re-run `npm run invite` and reinstall. |
| `feature declared gateway intents that are not enabled` | Feature needs a privileged intent you have not granted | Enable the portal toggle **and** `ENABLE_PRIVILEGED_INTENTS=true`, then restart. |
| Welcome greetings never appear | Greetings are off per guild | Run `/config-greeting enabled:true channel:#your-channel` as a member with Manage Server. |
| `/config-greeting` not in the picker | Command is hidden from members without Manage Server | Expected. It is intentionally restricted. |
| `/menu` says rank lookups are not set up | `HENRIK_DEV_API_KEY` is missing or blank | Add the key, or delete the line to accept that the feature is off, then restart. |
| `/menu` says the bot cannot manage roles | The bot lacks *Manage Roles* in that server | Server Settings → Roles → the bot's role → tick **Manage Roles**. No reinstall. |
| Rank role is not applied | The rank role sits at or above the bot's own role | Move the bot's role higher in Server Settings → Roles. |
| "This server has no role for that rank yet" | The 26 roles were never created | Press **Create rank roles** in `/menu` as someone with Manage Server. |
| A promotion does not show up | The free tier caches for 300 seconds | Wait five minutes, then **Refresh rank**. |
| `/rank` not in the picker | The command was never deployed | Run `npm run deploy:commands` again. |
| `/rank` says a member has not linked | They never used **Link account** | Expected. Nothing is looked up until they link. |
| Everyone had to relink after updating | One-time: the previous build kept links in memory, and there was no file to migrate | Run `/menu` → **Link account** once. From this version on, links survive a restart. |
| Greetings stopped after updating | Same one-time migration — greeting settings were also in memory | Run `/config-greeting` again in each server. |
| `database could not be opened or migrated` at startup | The file is not writable, or it was written by a newer build | Check `DATABASE_PATH` and the folder's permissions. A database from a newer version is refused on purpose rather than written to wrongly. |
| `feature manifests and the commands/ tree disagree` | A command file is not listed in its feature `index.ts` | Add it to the `commands` array, or remove the file. |
| `duplicate command name: the first registration wins` | Two features claim the same command name | Rename one of them. |
| `The client needs to be logged in to generate an invite link` | Calling `client.generateInvite` directly | Use `buildInstallUrl` from `src/core/permissions.ts` instead. It needs no client. |
| `login failed` on start | `Guilds` intent missing, or token invalid | Check `DISCORD_TOKEN`; the bot always requests `Guilds`. |

## Checklist

- [ ] `.env` exists and `npm run typecheck` / `npm test` / `npm run build` all pass.
- [ ] `npm run deploy:commands` completes without a disagreement error.
- [ ] `npm run invite` prints a URL containing `permissions=268453888` and no administrator bit.
- [ ] `/ping` replies after installing.
- [ ] `/menu` shows the menu; **Create rank roles** creates 26 roles and is safe to run twice.
- [ ] `/rank` replies ephemerally with your own rank; `/rank member:@someone` works for a linked
      member and refuses an unlinked one.
- [ ] `data/` exists after the first run, and `git status` does not list it.
- [ ] Restart the bot and run `/rank` again: the link is still there. That is the whole point.
- [ ] `.env` is gitignored and was never committed.
