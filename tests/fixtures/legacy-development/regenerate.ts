import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "prettier";
import { deriveLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import {
  buildLegacyArchives,
  buildPrePackDatabase,
  dumpSqliteDatabase,
  legacyArchiveFormats,
  legacyArchiveName,
  legacyFixturePath,
  legacyProfileInput,
  legacyRestoredProfileInput,
} from "../../helpers/legacy-development-fixture.ts";

// The GP-09 fixtures are frozen. The committed bytes are the source of truth:
// `pre-pack-project.sql`, `format-1.aioffice` to `format-4.aioffice` and both
// `expected-*.json` are read by the tests as they are, and no test requires
// current code to reproduce them.
//
//   bun tests/fixtures/legacy-development/regenerate.ts
//
// writes nothing. It builds each file with the current code and reports
// whether the result still equals the committed bytes. A difference is not a
// failure: the builders run current services, and an unrelated change there
// (one more generated ID is enough) moves their output. It is never a reason
// to refresh the frozen files.
//
// Re-creating a frozen file is a deliberate, reviewed act behind a flag:
//
//   --recreate-frozen-legacy-state
//       rewrites the dump and the four archives. Legitimate only when the
//       fixture itself has to hold something new (a legacy record kind the
//       tests need, a changed committed input). The new files are artefacts
//       of the code at that commit, not of an older release: say so in the
//       commit, update the checksums pinned in
//       `tests/integration/legacy-development-compatibility.test.ts`, and
//       review the profile version, since the pinned digests must still hold
//       or the version must be bumped.
//   --recreate-frozen-expected-profiles
//       rewrites both `expected-*.json`. They are the frozen profile version 1
//       of the committed inputs. A different result means the mapping or the
//       digest material changed: that is a new profile version with new
//       vectors, never a refresh of these files for version 1. Legitimate
//       only together with that reviewed version bump, or when the committed
//       inputs change.
const recreateState = "--recreate-frozen-legacy-state";
const recreateProfiles = "--recreate-frozen-expected-profiles";
const flags = process.argv.slice(2);
const unknown = flags.filter(
  (flag) => flag !== recreateState && flag !== recreateProfiles,
);
if (unknown.length > 0) {
  console.error(
    `Unknown argument: ${unknown.join(" ")}. Accepted: ${recreateState}, ${recreateProfiles}`,
  );
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "ai-office-gp09-fixture-"));
try {
  const database = await buildPrePackDatabase(root);
  const state: [string, string][] = [
    ["pre-pack-project.sql", dumpSqliteDatabase(database)],
  ];
  database.close();
  const archives = await buildLegacyArchives(root);
  for (const version of legacyArchiveFormats)
    state.push([legacyArchiveName(version), archives[version]]);
  // What a restored format 1-4 archive yields: the archive carries no guidance.
  const profiles: [string, string][] = [];
  for (const [name, input] of [
    ["expected-profile.json", legacyProfileInput()],
    ["expected-restored-profile.json", legacyRestoredProfileInput()],
  ] as const)
    profiles.push([
      name,
      await format(JSON.stringify(deriveLegacyDevelopmentProfile(input)), {
        parser: "json",
      }),
    ]);

  for (const [files, flag] of [
    [state, recreateState],
    [profiles, recreateProfiles],
  ] as const)
    for (const [name, built] of files) {
      const same = readFileSync(legacyFixturePath(name), "utf8") === built;
      if (flags.includes(flag)) {
        if (!same) writeFileSync(legacyFixturePath(name), built);
        console.log(`${name}: ${same ? "unchanged" : "RE-CREATED"}`);
      } else
        console.log(
          `${name}: ${same ? "current code reproduces the frozen bytes" : `current code builds different bytes; frozen file kept (${flag} re-creates it)`}`,
        );
    }
} finally {
  rmSync(root, { recursive: true, force: true });
}
