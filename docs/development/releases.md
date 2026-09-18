# Product versions and releases

AI Office uses one product version, owned by `version` in the root
`package.json`. `ai-office --version` and `ai-office -V` print that value, plus
source revision build metadata described below, and
exit locally, including through the development launcher. They do not select
a Runtime, open SQLite, contact IPC, or require source user-runtime opt-in.
The reported version identifies the CLI distribution, not a running daemon.

## Source revision and displayed version

The product version says which release line the code belongs to; a source
revision says which commit the running source checkout is based on (its `HEAD`).
They are reported together, never merged into `package.json`:

```text
Product version:
0.1.0

Source revision:
6fe106c41945909937466047926861f187bf32b8

Displayed source-linked version:
0.1.0+git.6fe106c41945
```

`ai-office --version` and `-V` print the displayed version: the product version
plus [SemVer build metadata](https://semver.org/#spec-item-10)
`+git.<first 12 characters of the revision>`. Build metadata identifies the
`HEAD` revision of the running source checkout, not necessarily the exact bytes
executing (see dirty state below), does not change SemVer precedence, and is not a protocol, schema,
migration, or profile version. It is deliberately not a prerelease
(`0.1.0-6fe106c41945` would sort below `0.1.0`). If the revision is not
authoritatively known, the plain product version is printed with exit code `0`;
no placeholder such as `+git.unknown` is invented.

`ai-office version` is the local diagnostic:

```text
AI Office 0.1.0
Revision: 6fe106c41945909937466047926861f187bf32b8
Distribution: source-linked
Dirty: no
```

Unknown values print `unavailable` (`Distribution: unknown`).
`ai-office version --json` has a stable contract; `null` means not
authoritatively known:

```json
{
  "contractVersion": 1,
  "version": "0.1.0",
  "displayVersion": "0.1.0+git.6fe106c41945",
  "revision": "6fe106c41945909937466047926861f187bf32b8",
  "dirty": false,
  "distribution": "source-linked"
}
```

New `distribution` values may be added without changing `contractVersion`.

Resolution is local Git inspection of the distribution root derived from the
executable, never from the working directory, and never the network:
`git rev-parse --show-toplevel`, `git rev-parse HEAD`, and, for `version`
only, `git status --porcelain=v1 --untracked-files=no`. Repository-selecting
variables such as `GIT_DIR` are ignored, and a distribution nested inside some
other repository does not report that repository's revision. It works for a
`.git` directory, a `.git` file, and linked worktrees. Neither command selects a
Runtime, opens SQLite, uses IPC, checks branches or upstreams, or requires
source user-runtime opt-in. HEAD resolution, revision validation, 12-character
formatting, and tracked dirty state are the same code `ai-office update` uses,
so the two commands cannot disagree about the checkout.

Dirty means tracked changes, staged or not; untracked files do not count.
`0.1.0+git.<revision>` identifies the checkout's base (`HEAD`) revision only.
`Dirty: yes` means the running source tree is not byte-equivalent to that
commit, so the executing files can differ from `HEAD`. The dirty state is
reported separately and is not part of the compact version (no `.dirty`
suffix): the compact version is a deterministic identity of the revision, while
a working tree can change without changing it. Use `ai-office version` to see
it.

The distribution root is the only source-identity provenance. A library caller
of the reusable client that supplies no distribution root, such as one that only
knows a project root, gets the plain product version and `null` revision,
dirty and distribution; a managed user project is never inspected.

A future packaged distribution supplies its version, revision, and
distribution kind from build-time metadata instead of Git inspection; the
public commands and JSON contract do not change. That packaging is not
implemented yet.

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
4. Include the repository [MIT LICENSE](../../LICENSE) and its copyright
   notice for Andrea Valla in the distribution. Preserve any required notices
   for bundled third-party components; their licenses remain independent.
5. Merge the reviewed change, then publish an immutable annotated `vX.Y.Z` tag
   and matching GitHub release at that exact commit with its changelog notes.
   Never move a published release tag; fixes receive a new version.
6. Verify the source-linked install/update and Runtime restart instructions.
   The current updater follows its configured Git upstream and exact approved
   commit; it does not select releases by SemVer or by GitHub release tags.

This procedure does not publish packages, create credentials, automate merges,
or introduce a second updater. Release automation can follow once this manual
contract has been exercised.
