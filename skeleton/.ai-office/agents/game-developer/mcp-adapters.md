---
trigger: when_referenced
---
# Game Developer MCP Adapters

## Available Adapters

| Adapter | Server | Usage |
|---------|--------|-------|
| `runcomfy` | `runcomfy` | AI-generated game assets |
| `fetch` | `fetch` | Fetch game development documentation |
| `sequential-thinking` | `sequential-thinking` | Complex game system design |
| `snyk` | `snyk` | Game security scanning |
| `ios-simulator` | `ios-simulator` | iOS game testing |
| `playwright` | `playwright` | Web game testing |

## Adapter Usage Patterns

### runcomfy

**When Used:**
- AI-generated game textures
- Concept art for games
- Placeholder assets

**Example:**
```
Generate game texture for fantasy environment
```

### ios-simulator

**When Used:**
- iOS game testing
- Mobile game performance
- Touch control testing

**Example:**
```
Test iOS game on simulator for performance
```

### playwright

**When Used:**
- Web game testing
- Browser game compatibility
- WebGL testing

**Example:**
```
Test web game across browsers
```

### snyk

**When Used:**
- Game dependency scanning
- Multiplayer security
- Anti-cheat validation

**Example:**
```
Scan game dependencies for vulnerabilities
```

### fetch

**When Used:**
- Game engine documentation
- Platform SDK documentation
- Best practices research

**Example:**
```
Fetch Unity documentation for new feature
```

### sequential-thinking

**When Used:**
- Complex game system design
- Multiplayer architecture
- Performance optimization planning

**Example:**
```
Design multiplayer system:
- Network architecture
- State synchronization
- Latency compensation
- Anti-cheat measures
```

## Adapters NOT Used

Game Developer does NOT use:
- `supabase` - Database operations (unless backend needed)
- `lighthouse` - Performance auditing (QA responsibility)
- `stitch` - UI generation (Designer responsibility)
- `revenuecat` - Revenue operations (unless IAP needed)

## Adapter Constraints

Game Developer has broad access for game development:

- **Full code access** - Read and write game code
- **RunComfy access** - AI asset generation
- **iOS Simulator access** - Mobile game testing
- **Playwright access** - Web game testing
- **Snyk access** - Security scanning

Game Developer's role is game implementation with appropriate tooling.
