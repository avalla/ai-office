BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, core;

SELECT * FROM no_plan();

INSERT INTO core.tenant(id, name, created_at, updated_at)
VALUES (
  'pgtap-title-event-tenant', 'Title Event Tenant',
  '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z'
);
INSERT INTO core.project(id, name, tenant_id, created_at, updated_at)
VALUES (
  'pgtap-title-event-project', 'Title Event Project', 'pgtap-title-event-tenant',
  '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z'
);
INSERT INTO core.milestone(id, project_id, title, status, created_at, updated_at)
VALUES (
  'pgtap-title-event-milestone', 'pgtap-title-event-project', 'Before', 'planned',
  '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z'
);

SELECT lives_ok(
  $$
    INSERT INTO core.governance_event(
      id, project_id, event_type, aggregate_id, metadata_json, occurred_at
    ) VALUES (
      'pgtap-title-event-change', 'pgtap-title-event-project',
      'milestone.title_changed', 'pgtap-title-event-milestone',
      '{"from":"Before","to":"After"}'::jsonb, '2026-09-25T01:00:00Z'
    )
  $$,
  'milestone title changes are accepted as governance events'
);

SELECT * FROM finish();
ROLLBACK;
