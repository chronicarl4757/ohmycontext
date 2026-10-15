export interface Page<P> {
  key(p: P): string;
  load(p: P): Promise<unknown>;
  /** cheap change detection for SWR re-renders; default = JSON compare */
  same?(a: unknown, b: unknown): boolean;
  view(root: HTMLElement, data: unknown, p: P): void | (() => void);
}
