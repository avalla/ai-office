# Dashboard design

The operator reads task descriptions and compares work across agents on a desktop
during development, with occasional checks on a narrow screen. Retain system
light/dark preferences so the console matches the surrounding workspace.

## Color and typography

Restrained neutral surfaces with blue for active work, amber for attention,
green for completion, and muted text for inactive state. Colors supplement
labels. Use the existing system sans-serif and monospace stack for identifiers
and timestamps; use tabular numerals for counts.

## Layout and components

Keep the persistent header and centered content area. Put task navigation and
progress near the project heading. Charts use labelled horizontal bars with
visible counts and clear denominators, without new chart dependencies.
Task details are their own route with breadcrumbs, readable description,
assignment evidence, pipeline stages, run history, and scoped activity.

Put search, operational status, numeric priority, and current agent filters above
the task table. Choices reflect persisted project data; do not invent a priority
scale or role vocabulary. Keep filters and page in the URL, retain edits during
live refresh, and show matching and project totals separately. Charts describe
the whole project and omit empty categories; avoid duplicate or empty sections.

Tables scroll within their section on narrow screens. Summary metadata wraps;
long identifiers and descriptions must not widen the entire page. Use native
links, focus outlines, and no decorative animation.
