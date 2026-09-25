# Dashboard View
> Project filters and milestone visualization

Entry: `apps/dashboard/src/ui/app.ts:renderRoute()`
Flow: project query → `ProjectDetail` → `projectViewModel()` → `renderProject()` → browser DOM.

Task filters: URL-backed search, operational status, persisted numeric priority, current agent, unassigned, and pagination. Controls are restored during live refresh.

Milestones: `ProjectDetail.milestones` provides persisted milestone summaries and requirement counts. The dashboard filters milestone rows client-side by their actual status and shows verified/total progress.

Limitation: `TaskOperationalState.milestone` is unavailable with reason `task_milestone_link_not_modelled`; do not present milestone-task associations as facts.

Updated: 2026-09-25
