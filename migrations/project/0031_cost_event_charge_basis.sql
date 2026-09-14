-- How each cost event's amount was determined.
--
-- 'reported_usage': the provider's reported usage priced with the pricing
-- version. Every cost event recorded before this migration was priced this way,
-- so existing rows take it as their default.
--
-- 'reserved_envelope': the provider answered but the answer was rejected before
-- its usage could be priced (for example a different effective model or a
-- malformed response). The worst-case envelope reserved before the request is
-- charged so an answered request never becomes free; the usage row keeps
-- whatever the provider validly reported, such as the substituted model.
ALTER TABLE cost_event ADD COLUMN charge_basis TEXT NOT NULL DEFAULT 'reported_usage'
  CHECK (charge_basis IN ('reported_usage', 'reserved_envelope'));
