# Addon: Frontend React

## File Naming

- **PascalCase** for React component files: `UserCard.tsx`, `DashboardLayout.tsx`
- **kebab-case** for non-component files: hooks, utilities, services
- Prefer **named exports** for components; avoid default exports.

## Component Structure

- Functional components with hooks only; no class components.
- File order: exported component → subcomponents → helpers → static content → types.
- Keep components small and focused (single responsibility).
- Use early returns to reduce nested conditions.
- Keep business logic in custom hooks, not in components.

## Project Structure (Feature-Based)

```
src/
  features/
    auth/
      components/
      hooks/
      services/
      types/
      index.ts
  shared/
    components/
    hooks/
    utils/
    types/
  pages/
  layouts/
```

- Use absolute imports with path aliases (`@/features`, `@/shared`, etc.).
- Use **barrel exports** (`index.ts`) for cleaner imports.

## State Management

- React Context for global state (auth, theme).
- TanStack Query (React Query) or equivalent for server state.
- Local `useState` for UI-only state; `useReducer` for complex local state.
- Immutable state updates; avoid prop drilling.

## Performance

- `React.memo()` for expensive pure components.
- `useCallback` and `useMemo` with correct dependency arrays.
- Code splitting with `React.lazy` + `Suspense`.
- Virtual scrolling for large lists.
- Optimize images: WebP format, lazy loading.

## Accessibility & Responsive

- Mobile-first responsive design.
- ARIA roles and native accessibility props on all interactive elements.
- Focus states for all interactive elements.
- Test color contrast for accessibility compliance.
- Semantic HTML5 (`<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<footer>`).

## Error Handling

- Error boundaries for graceful component failures.
- Show user-friendly error messages.
- Handle loading, empty, and error states explicitly in every data-fetching component.

## Testing

- Test behavior, not implementation.
- Mock external dependencies.
- Test happy path, edge cases, error states, and loading states.
- Aim for ≥ 80% code coverage.
