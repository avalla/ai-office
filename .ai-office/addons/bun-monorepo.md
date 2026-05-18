# Addon: Bun & Monorepo

## Runtime

- Default to Bun instead of Node.js for all operations.
- `bun <file>` instead of `node`/`ts-node`.
- `bun install` instead of `npm`/`yarn`/`pnpm install`.
- `bun run <script>` instead of `npm run`.
- `bun test` instead of jest/vitest (unless project explicitly uses vitest).
- Bun auto-loads `.env`; don't add `dotenv`.

## Bun APIs

- `Bun.serve()` for HTTP servers (supports WebSockets, HTTPS, routes).
- `Bun.file()` over `node:fs` readFile/writeFile.
- `bun:sqlite` for SQLite, `Bun.sql` for Postgres, `Bun.redis` for Redis.
- Built-in `WebSocket`; don't add the `ws` package.

## Monorepo

- Shared logic lives in `packages/`; app-specific logic in `apps/`.
- Use workspace protocol for internal dependencies (`workspace:*`).
- Use absolute imports with path aliases (`@/features`, `@/shared`, etc.).
- Keep packages focused: one responsibility per package.
- After modifying dependencies, restart dev server (`bun --hot` may cache stale modules).
- Run `bun install` to link workspace packages after dependency changes.
