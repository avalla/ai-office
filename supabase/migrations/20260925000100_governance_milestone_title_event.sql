ALTER TABLE core.governance_event
  DROP CONSTRAINT governance_event_event_type_check;

ALTER TABLE core.governance_event
  ADD CONSTRAINT governance_event_event_type_check CHECK (
    event_type IN (
      'milestone.created', 'milestone.status_changed', 'milestone.title_changed',
      'requirement.created', 'requirement.status_changed',
      'adr.created', 'adr.status_changed',
      'review.created', 'review.decided'
    )
  );
