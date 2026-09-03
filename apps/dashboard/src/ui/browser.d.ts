/**
 * Minimal ambient browser declarations.
 *
 * The repository's `tsconfig.json` deliberately omits the DOM library so that
 * domain and application code cannot reach browser globals by accident. The
 * dashboard shell is the one module that genuinely runs in a browser, so it
 * declares exactly the surface it uses instead of enabling the DOM lib
 * repository-wide.
 */

interface DashboardElement {
  innerHTML: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

interface DashboardDocument {
  getElementById(id: string): DashboardElement | null;
  addEventListener(type: string, listener: () => void): void;
}

interface DashboardLocation {
  readonly hash: string;
  readonly origin: string;
}

interface DashboardWindow {
  readonly location: DashboardLocation;
  addEventListener(type: string, listener: () => void): void;
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(handle: number): void;
}

/**
 * The browser `EventSource` constructor. Bun's ambient declaration describes
 * its own server-side shape, so the shell casts the global to this contract
 * rather than redeclaring a conflicting global.
 */
interface DashboardEventSource {
  addEventListener(type: string, listener: () => void): void;
  close(): void;
}

interface DashboardEventSourceConstructor {
  new (url: string, init?: { withCredentials?: boolean }): DashboardEventSource;
}

declare const document: DashboardDocument;
declare const window: DashboardWindow;
