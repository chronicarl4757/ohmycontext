export type { Connector, ParseResult } from './types.js';
export { claudeCodeConnector } from './claude-code.js';
export { codexConnector } from './codex.js';

import type { Connector } from './types.js';
import { claudeCodeConnector } from './claude-code.js';
import { codexConnector } from './codex.js';

export function defaultConnectors(): Connector[] {
  return [claudeCodeConnector(), codexConnector()];
}
