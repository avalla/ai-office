# Secure Supabase RPC checklist

- [ ] `SECURITY DEFINER` is justified.
- [ ] `search_path` is explicit and minimal.
- [ ] Object names are schema-qualified where appropriate.
- [ ] Dynamic SQL is absent or safely parameterized.
- [ ] Pagination has hard bounds.
- [ ] Anonymous and authenticated roles are tested.
- [ ] Sensitive columns are not returned.
- [ ] pgTAP covers authorization and malformed input.
