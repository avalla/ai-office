# Product versions and releases

AI Office uses one product version, owned by `version` in the root
`package.json`. `ai-office --version` and `ai-office -V` print that value and
exit locally, including through the development launcher. They do not select
a Runtime, open SQLite, contact IPC, or require source user-runtime opt-in.
The reported version identifies the CLI distribution, not a running daemon.

Workspace packages remain private implementation modules without independently
published versions. Protocol versions, query API versions, SQLite migration
numbers, snapshot formats, and agent profile versions have independent
compatibility rules; a product bump never changes them automatically.

## Initial baseline

`0.1.0` is the initial development baseline. Adding this value does not publish
a release or promise an autonomous worker. The current distribution remains a
source-linked Bun checkout. The controlled-action boundary, deterministic run
executor, and explicit recovery limitations remain as documented.

Follow [Semantic Versioning](https://semver.org/). While the product is `0.x`,
use patch releases for compatible fixes and minor releases for features or
breaking changes, documenting the latter explicitly. Reserve `1.0.0` for a
declared supported public contract. Public surfaces include documented CLI
syntax/exit codes, machine-readable output, IPC/query compatibility, and upgrade
behavior; private TypeScript modules are not a published SDK.

## Release procedure

1. Finish or explicitly defer pending work. Use a clean branch with an upstream;
   do not release from a worktree containing unrelated changes.
2. Update the root product version and lockfile metadata if required. Record
   changes, compatibility impact, upgrade steps, and limitations in
   `CHANGELOG.md`. Keep unreleased work under `Unreleased` until release.
3. Run `bun install --frozen-lockfile`, `bun run check`, the committed diff
   whitespace check, and `bun run smoke:bun-link` in isolated fixtures. Verify
   the product-version command remains local. All CI jobs must pass on the
   intended release commit.
4. Confirm the repository LICENSE and ownership notice before distributing a
   public release. Do not infer licensing from a public GitHub repository or
   from the licenses of dependencies.
5. Merge the reviewed change, then publish an immutable annotated `vX.Y.Z` tag
   and matching GitHub release at that exact commit with its changelog notes.
   Never move a published release tag; fixes receive a new version.
6. Verify the source-linked install/update and Runtime restart instructions.
   The current updater follows its configured Git upstream and exact approved
   commit; it does not select releases by SemVer or by GitHub release tags.

This procedure does not publish packages, create credentials, automate merges,
or introduce a second updater. Release automation can follow once this manual
contract has been exercised.
