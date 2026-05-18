# Addon: React Native + Expo

## Project Structure

```
src/
  components/
  screens/
  navigation/
  hooks/
  utils/
  services/
  types/
  assets/
```

- Absolute imports with path aliases (`@/components`, `@/hooks`, etc.).
- Screens in `src/screens/` with minimal coupling.
- Navigators under `src/navigation/`.

## Rules

- Functional components with hooks only; no class components.
- Use Expo SDK APIs whenever possible over third-party alternatives.
- React Navigation for all routing; type route parameters with `RootStackParamList`.
- `StyleSheet` for styling (consistent and performant).
- `Expo SecureStore` for all tokens and sensitive data — never AsyncStorage for secrets.
- Error boundaries + crash reporting on all screens.
- TypeScript strict mode.

## Performance

- `useMemo` and `useCallback` to prevent unnecessary re-renders.
- `React.memo` for pure UI components.
- FlatList: `keyExtractor`, `getItemLayout`, `windowSize`.
- Lazy-load heavy screens.
- Preload fonts and images with `Asset` and `Font` APIs.

## Security

- All tokens and secrets in SecureStore only.
- Never commit credentials.
- Validate all API inputs and outputs.
- HTTPS/TLS for all network requests.

## Avoid

- Class components
- Non-Expo APIs when an Expo alternative exists
- Logging secrets or sensitive info
- Heavy synchronous work on the UI thread
- Inline objects or functions as props (causes re-renders)
