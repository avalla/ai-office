# ADR-0024: autorizzazione tenant PostgreSQL con helper privati e RLS

- **Data**: 2026-09-19
- **Stato**: accettata
- **Decisori**: AI Office maintainers
- **Tag**: PostgreSQL, Supabase, sicurezza, tenancy

## Contesto e problema

AI Office Pro deve isolare gli utenti autenticati fra tenant e progetti senza
trasformare i claim JWT in autorità applicativa. `core.tenant_member` è la
fonte definitiva per membership e ruoli; `auth.uid()` identifica soltanto il
principal umano. La stessa storia di migration deve restare applicabile a
PostgreSQL ordinario, dove gli oggetti Supabase Auth e i ruoli Data API possono
non esistere.

## Decisione

Introduciamo uno schema `private` non esposto dalla Data API con helper
`SECURITY DEFINER`, `SET search_path = ''`, riferimenti qualificati e `STABLE`:

- `private.is_tenant_member(tenant_id)`;
- `private.has_tenant_role(tenant_id, roles)`;
- `private.can_access_project(project_id)`;
- `private.can_manage_project(project_id)`.

Un helper interno risolve `auth.uid()` dinamicamente. Se Auth non è installato,
l’identità è assente o la risoluzione fallisce, il risultato è `NULL` e ogni
decisione umana è deny-by-default. Gli helper leggono sempre
`core.tenant_member`; non leggono `raw_app_meta_data`, array tenant JWT o ruoli
nel token. L’`EXECUTE` pubblico è revocato.

Abilitiamo RLS su tenant, membership, invite, project e sulle tabelle
project-owned di task e governance, incluso il solo projection table
`core.agent_run`. Le policy concedono accesso in base alla membership del
tenant; project creation/update/delete richiede owner/admin. Owner può gestire
admin/member, admin può gestire member, member non gestisce membership. Le
membership owner non sono mutabili tramite ordinary CRUD. `tenant_id IS NULL`
è sempre invisibile agli utenti autenticati.

Tenant visibility is deliberately separate from governance authority. The
authenticated role has tenant-scoped `SELECT` only on `core.review`,
`core.approval`, `core.governance_event`, and the Runtime-owned
`core.agent_run` projection. It has no direct governance INSERT/UPDATE/DELETE
path, regardless of whether the database membership role is owner, admin, or
member. Review provenance, approval actor identity, review finalization, and
governance event insertion therefore remain on the existing Runtime/server-side
table-owner boundary. This staged boundary avoids trusting client-supplied
human, agent, or system actor fields; a future human decision RPC must derive
and bind the human actor from `auth.uid()` and the review's expected reviewer.

Un trigger riusabile confronta il tenant effettivo del vecchio e del nuovo
`project_id` su ogni riga project-owned e rifiuta il reparenting cross-tenant.
Il reparenting fra progetti dello stesso tenant resta possibile quando le altre
business constraint lo consentono. Un secondo guard rende immutabile il tenant
di una membership.

`tenant_invite` concede ad authenticated solo la selezione di colonne sicure:
`token_hash` resta non leggibile. Le policy e i grants di authenticated vengono
creati soltanto se quel ruolo esiste; `anon`, `PUBLIC` e lo schema `private`
non ricevono privilegi applicativi. Non creiamo ruoli o funzioni Supabase fittizi.

Il Runtime/server-side PostgreSQL continua a usare il trust boundary esistente
del proprio principal tecnico e non assume `service_role`. Il flusso umano è
`JWT -> authenticated -> auth.uid() -> core.tenant_member -> RLS`; il principal
definitivo del Runtime sarà deciso nella futura slice AgentRuntime parity.

The role matrix is intentionally asymmetric: owner/admin retain the project and
membership management authority described above; owner/admin/member share
tenant-scoped governance visibility; none of them directly write authoritative
governance records; non-members and `anon` have no access. This does not change
the Runtime table-owner contract or the portable Project domain.

## Conseguenze

La revoca in `core.tenant_member` ha effetto alla query successiva senza refresh
JWT e fake tenant claims non concedono accesso. Join fra tabelle RLS-protected
non bypassano l’isolamento. I contratti PostgreSQL standalone continuano a
scrivere come server-side owner, mentre una connessione umana senza Supabase
Auth resta fail-closed.

Lite resta SQLite, local-first e tenant-agnostic; il domain `Project` non riceve
`tenantId`. La colonna PostgreSQL `core.project.tenant_id` resta nullable nella
migrazione staged. Non sono incluse tenant-aware project creation/import,
invite acceptance, signup, auth.users binding, ownership transfer, API/UI,
billing, Storage/Realtime, un permission engine generico o il Runtime service
principal definitivo. Queste decisioni appartengono alle slice successive.

## Alternative considerate

- **Claim JWT come authority**: rifiutata perché membership, revoca e ruoli
  diventerebbero stale e manipolabili rispetto alla fonte DB.
- **FK obbligatoria a `auth.users` e oggetti Supabase in ogni migration**:
  rifiutata perché rompe PostgreSQL standalone e il migration runner condiviso.
- **Denormalizzare `tenant_id` in ogni aggregate**: rifiutata perché duplica
  authority; i dati normali ereditano il tenant tramite `project_id`.

## Riferimenti

- [ADR-0023: PostgreSQL tenant authority](ADR-0023-postgres-tenant-authority.md)
- `supabase/migrations/20260919030000_tenant_rls.sql`
