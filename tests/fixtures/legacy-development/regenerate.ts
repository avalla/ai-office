import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Rebuilds the generated GP-09 fixtures from the committed inputs
// (`office-manifest.json`, `runtime-definitions.json`):
//
//   bun tests/fixtures/legacy-development/regenerate.ts
//
// The output is deterministic, so an unchanged tree rewrites identical bytes.
// The `expected-*.json` files are the frozen profile version 1 of the inputs;
// a different result there means the mapping or the digest material changed and
// the profile version must be bumped, not the files refreshed.
const root = mkdtempSync(join(tmpdir(), "ai-office-gp09-fixture-"));
try {
  const database = await buildPrePackDatabase(root);
  writeFileSync(
    legacyFixturePath("pre-pack-project.sql"),
    dumpSqliteDatabase(database),
  );
  database.close();
  const archives = await buildLegacyArchives(root);
  for (const format of legacyArchiveFormats)
    writeFileSync(
      legacyFixturePath(legacyArchiveName(format)),
      archives[format],
    );
  // What a restored format 1-4 archive yields: the archive carries no guidance.
  for (const [name, input] of [
    ["expected-profile.json", legacyProfileInput()],
    ["expected-restored-profile.json", legacyRestoredProfileInput()],
  ] as const)
    writeFileSync(
      legacyFixturePath(name),
      await format(JSON.stringify(deriveLegacyDevelopmentProfile(input)), {
        parser: "json",
      }),
    );
} finally {
  rmSync(root, { recursive: true, force: true });
}
