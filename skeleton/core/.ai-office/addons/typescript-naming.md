# Addon: TypeScript Naming Conventions

## File & Directory Names

- **kebab-case** for directories and `.ts` files: `user-service.ts`, `api-client/`
- **PascalCase** for component files (`.tsx`): `UserCard.tsx`, `DashboardLayout.tsx`
- **camelCase** for hook files: `useAuth.ts`

## Code Identifiers

- **PascalCase**: React components, TypeScript interfaces and types, class names
- **camelCase**: variables, functions, hooks, constants within functions
- **SCREAMING_SNAKE_CASE**: module-level constants, environment variables, configuration values

## Booleans

Prefix with auxiliary verbs:
- `is` for state: `isOpen`, `isActive`, `isLoading`
- `has` for possession: `hasPermission`, `hasError`
- `can` for ability: `canEdit`, `canDelete`
- `should` for intent: `shouldRefresh`, `shouldValidate`

## Async Functions

- `fetch*` for data retrieval: `fetchUser()`, `fetchPosts()`
- `load*` for loading state: `loadConfig()`, `loadData()`
- `handle*` for event handlers: `handleClick()`, `handleSubmit()`

## Avoid

- Abbreviations: ❌ `usr`, `btn`, `hdl` → ✅ `user`, `button`, `handle`
- Default exports (prefer named exports)
- Generic names like `data`, `item`, `obj` without context
