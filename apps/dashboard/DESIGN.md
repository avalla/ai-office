# Dashboard design

The dashboard is the read-only operations console. Its first screen answers what is active, who is working, what is assigned, and what needs attention. Desktop uses a persistent sidebar and a dense but readable content column; mobile uses a Sheet.

## Visual language

System sans-serif text and comfortable line-height carry primary information. Technical IDs use monospace, truncate visually, and expose their full value in a title. Neutral surfaces use blue for active work, amber for attention, and green for completion. Every badge also has a symbol and text. Counts use tabular numerals. The palette follows `prefers-color-scheme` and keeps sufficient contrast in light and dark mode.

## Information hierarchy

Overview begins with authoritative totals and active work. Project overview stays compact and links to Pipeline, Tasks, Milestones, Requirements, and Agents. The pipeline page highlights its current stage and shows the persisted stage sequence, assignment, active pipeline runs, and involved agents. Assignment is never presented as evidence of a working run. A run's pipeline current stage is context, because the read model has no run-to-stage relation.

Task search, operational status, persisted numeric priority, current agent, unassigned, milestone, sort, and pagination stay in the hash URL. Draft controls remain mounted through live refresh. Task and run details show recorded facts and operational interpretation separately. Exact totals accompany truncated samples.

Native links, labelled controls, visible focus, heading order, screen-reader status, reduced motion, responsive table scrolling, and bounded text widths are required. Avoid nested cards and decorative charts. The Graph section is functional, not decorative: every node is a native button, edge colour never carries meaning alone (the legend and side panel repeat it as text), and the side-panel lists give a keyboard path through the graph.
