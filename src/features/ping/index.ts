import type { Feature } from '../../core/registry.js';
import { data, execute } from './commands/ping.js';

/**
 * Reference feature: one folder, one command, zero edits to core files.
 */
export default {
  name: 'ping',
  description: 'Liveness check for the bot connection.',
  commands: [{ data, execute }],
} satisfies Feature;
