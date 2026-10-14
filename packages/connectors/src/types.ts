import type { OmcEvent } from '@ohmycontext/core';

export interface ParseResult {
  events: OmcEvent[];
  offset: number;
}

export interface Connector {
  readonly name: string;
  dirs(): string[];
  parse(filePath: string, offset: number): Promise<ParseResult>;
}
