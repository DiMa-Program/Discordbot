/**
 * Per-guild greeting settings.
 *
 * Deliberately in-memory and deliberately DISABLED by default. A reference feature must not start
 * posting in servers it was merely installed into, so a guild has to opt in through
 * `/config-greeting` before anything is sent. State is lost on restart, which is fine for a
 * demonstration — replace this module with a real store when the feature graduates.
 */

export interface GreetingSettings {
  readonly enabled: boolean;
  /** Channel the greeting is posted to, or `null` while unset. */
  readonly channelId: string | null;
}

const DISABLED: GreetingSettings = { enabled: false, channelId: null };

const settingsByGuild = new Map<string, GreetingSettings>();

/** Current settings for a guild, defaulting to disabled with no channel. */
export function getGreetingSettings(guildId: string): GreetingSettings {
  return settingsByGuild.get(guildId) ?? DISABLED;
}

/**
 * Whether a greeting should actually be sent.
 *
 * Requires both the flag and a target channel, so enabling the feature without configuring a
 * channel cannot produce a greeting with nowhere to go.
 */
export function isGreetingEnabled(guildId: string): boolean {
  const settings = getGreetingSettings(guildId);
  return settings.enabled && settings.channelId !== null;
}

/** Replaces a guild's settings and returns the stored value. */
export function configureGreeting(
  guildId: string,
  settings: { readonly enabled: boolean; readonly channelId: string | null },
): GreetingSettings {
  const next: GreetingSettings = { enabled: settings.enabled, channelId: settings.channelId };
  settingsByGuild.set(guildId, next);
  return next;
}

/** Clears all state. Exists for tests; nothing in the running bot calls it. */
export function resetGreetingSettings(): void {
  settingsByGuild.clear();
}
