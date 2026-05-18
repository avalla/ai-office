# Addon: Supabase

## Database

- All tables MUST have Row Level Security (RLS) enabled.
- Use singular table names (`account`, `listing`, `bid`).
- Primary keys are UUIDs (`gen_random_uuid()`).
- Always include `created_at` and `updated_at` timestamps.
- Use `deleted` boolean for soft deletes; never hard-delete user data.
- Index all foreign keys and common search fields.

## Migrations

- Don't create new migrations unless absolutely necessary (new entities, RLS, functions).
- During development, prefer modifying existing migrations + `db reset` over adding new ones.
- Always test migrations with `bun run supabase db reset` after changes.
- Generate TypeScript types after schema changes: `bun run supabase gen types typescript --local`.

## RLS Best Practices

- Write policies for all CRUD operations per role.
- Keep policies to 1–2 per table; move complexity to precomputed fields or app-layer checks.
- Avoid VOLATILE functions (`now()`, `random()`) in policy predicates.
- Every column used in RLS must be indexed.
- Use `STABLE` helper functions that read JWT claims only.
- Prefer tenant isolation with `tenant_id` on every tenant-scoped table.
- Test RLS with pgTAP for every role: allow + deny + cross-tenant.

## Security

- Use dedicated schemas; avoid `public` for sensitive tables.
- Set `search_path` explicitly inside SECURITY DEFINER functions.
- Minimize SECURITY DEFINER usage; keep functions small and audited.
- GRANT only what is necessary to each role.
- Never commit secrets; use `.env.example` and secret managers.
- Store and verify webhook signatures; persist raw events for audit/replay.
- Implement idempotency keys for external side-effect operations.

## Queries

- Always type Supabase queries with generated types.
- Use `.select()` with explicit columns; avoid `select('*')` in production.
- For queries with joins, derive the result type using `QueryData<typeof query>`.
- Handle loading, error, and empty states for every query.

## Edge Functions

- Put shared helpers in `supabase/functions/_shared`.
- Use hyphenated function names (URL-friendly).
- Keep JWT verification enabled by default; disable only for webhook endpoints.
- Validate all inputs; return proper HTTP status codes and structured error responses.
- Use Deno runtime conventions.

## Testing

- `bun run supabase test db` for database tests.
- Always `bun run supabase db reset` before analyzing test failures.
- Seed data must be consistent with test assertions.
