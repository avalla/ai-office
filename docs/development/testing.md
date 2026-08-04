# Testing strategy

## Unit tests

Cover:

- domain state transitions;
- cost calculation;
- budget policy;
- task prioritization;
- pattern applicability.

## Integration tests

Use temporary SQLite files and real migrations.

Cover:

- repository round trips;
- transaction rollback;
- migration order;
- foreign keys;
- event and aggregate consistency.

## End-to-end tests

Cover:

```text
CLI -> daemon -> application -> SQLite -> CLI output
```

Do not call paid providers in standard CI. Use deterministic mocks.
