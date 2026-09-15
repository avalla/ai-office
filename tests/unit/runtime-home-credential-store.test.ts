import { afterEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  maximumProviderCredentialBytes,
  inspectRuntimeHomeCredential,
  loadRuntimeHomeCredentialValue,
  ProviderCredentialStoreError,
  removeRuntimeHomeCredential,
  writeRuntimeHomeCredential,
  type RuntimeHomeCredentialInspection,
} from "@ai-office/llm-gateway/runtime-home-credential-store.ts";

const name = "OPENAI_API_KEY";
const secret = `aio-test-secret-${randomBytes(12).toString("hex")}`;
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "ao-credentials-"));
  homes.push(value);
  return value;
}

/** A home with an owner-only credential directory and file holding `content`. */
function planted(content: string | Buffer, fileMode = 0o600): string {
  const value = home();
  mkdirSync(join(value, "credentials"), { mode: 0o700 });
  const path = join(value, "credentials", name);
  writeFileSync(path, content, { mode: fileMode });
  chmodSync(path, fileMode);
  return value;
}

function errorFrom(action: () => unknown): ProviderCredentialStoreError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCredentialStoreError);
    return error as ProviderCredentialStoreError;
  }
  throw new Error("expected a credential store error");
}

describe("loading a Runtime home credential value", () => {
  test("accepts an owner-only regular file and tolerates one trailing newline", () => {
    expect(loadRuntimeHomeCredentialValue(planted(secret), name)).toEqual({
      state: "present",
      value: secret,
    });
    expect(
      loadRuntimeHomeCredentialValue(planted(`${secret}\n`), name),
    ).toEqual({
      state: "present",
      value: secret,
    });
    expect(
      loadRuntimeHomeCredentialValue(planted(`${secret}\r\n`), name),
    ).toEqual({
      state: "present",
      value: secret,
    });
  });

  test("reports a missing directory or file as missing", () => {
    expect(loadRuntimeHomeCredentialValue(home(), name)).toEqual({
      state: "missing",
    });
    const empty = home();
    mkdirSync(join(empty, "credentials"), { mode: 0o700 });
    expect(loadRuntimeHomeCredentialValue(empty, name)).toEqual({
      state: "missing",
    });
  });

  test.each([0o640, 0o604, 0o660, 0o644, 0o606])(
    "refuses a file with group or other access (mode %s)",
    (mode) => {
      expect(
        loadRuntimeHomeCredentialValue(planted(secret, mode), name),
      ).toEqual({
        state: "invalid",
        issue: "CREDENTIAL_INSECURE_PERMISSIONS",
      });
    },
  );

  test.each([0o750, 0o705, 0o777])(
    "refuses a credential directory with group or other access (mode %s)",
    (mode) => {
      const value = planted(secret);
      chmodSync(join(value, "credentials"), mode);
      expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
        state: "invalid",
        issue: "CREDENTIAL_DIRECTORY_INSECURE",
      });
    },
  );

  test("refuses credentials not owned by the Runtime user", () => {
    const value = planted(secret);
    const uid = vi
      .spyOn(process, "getuid")
      .mockReturnValue(process.getuid!() + 1);
    try {
      expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
        state: "invalid",
        issue: "CREDENTIAL_DIRECTORY_INSECURE",
      });
      expect(
        errorFrom(() =>
          writeRuntimeHomeCredential(value, name, Buffer.from(secret)),
        ).code,
      ).toBe("CREDENTIAL_DIRECTORY_INSECURE");
    } finally {
      uid.mockRestore();
    }
  });

  test("never follows a symbolic link to a credential", () => {
    const value = home();
    mkdirSync(join(value, "credentials"), { mode: 0o700 });
    const target = join(value, "elsewhere");
    writeFileSync(target, secret, { mode: 0o600 });
    symlinkSync(target, join(value, "credentials", name));
    expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
      state: "invalid",
      issue: "CREDENTIAL_SYMLINK",
    });
  });

  test("refuses a symbolic link in place of the credential directory", () => {
    const value = home();
    const real = join(value, "real");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, name), secret, { mode: 0o600 });
    symlinkSync(real, join(value, "credentials"));
    expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
      state: "invalid",
      issue: "CREDENTIAL_DIRECTORY_INSECURE",
    });
  });

  test("refuses a directory or FIFO at the credential name without blocking", () => {
    const directory = home();
    mkdirSync(join(directory, "credentials", name), {
      recursive: true,
      mode: 0o700,
    });
    chmodSync(join(directory, "credentials"), 0o700);
    expect(loadRuntimeHomeCredentialValue(directory, name)).toEqual({
      state: "invalid",
      issue: "CREDENTIAL_NOT_REGULAR_FILE",
    });

    const fifo = home();
    mkdirSync(join(fifo, "credentials"), { mode: 0o700 });
    const made = spawnSync("mkfifo", [
      "-m",
      "600",
      join(fifo, "credentials", name),
    ]);
    if (made.status !== 0) return;
    expect(loadRuntimeHomeCredentialValue(fifo, name)).toEqual({
      state: "invalid",
      issue: "CREDENTIAL_NOT_REGULAR_FILE",
    });
  });

  test("refuses an oversized credential", () => {
    expect(
      loadRuntimeHomeCredentialValue(
        planted("a".repeat(maximumProviderCredentialBytes + 3)),
        name,
      ),
    ).toEqual({ state: "invalid", issue: "CREDENTIAL_TOO_LARGE" });
    expect(
      loadRuntimeHomeCredentialValue(
        planted("a".repeat(maximumProviderCredentialBytes)),
        name,
      ).state,
    ).toBe("present");
  });

  test.each([
    ["empty", ""],
    ["only a newline", "\n"],
    ["NUL", `${secret}\0`],
    ["embedded newline", `${secret}\nsecond-line`],
    ["space", `${secret} tail`],
    ["tab", `\t${secret}`],
    ["two trailing newlines", `${secret}\n\n`],
    ["quoted shell assignment", `export OPENAI_API_KEY="${secret}"`],
    ["non-ASCII", `${secret}é`],
    ["escape character", `${secret}\x1b[2J`],
  ])("fails closed on a malformed credential (%s)", (_label, content) => {
    expect(loadRuntimeHomeCredentialValue(planted(content), name)).toEqual({
      state: "invalid",
      issue: "CREDENTIAL_MALFORMED",
    });
  });

  test("rejects names that are not environment-style credential names", () => {
    for (const bad of ["../OPENAI_API_KEY", "openai_api_key", "A/B", ""])
      expect(
        errorFrom(() => loadRuntimeHomeCredentialValue(home(), bad)).code,
      ).toBe("CREDENTIAL_NAME_INVALID");
  });

  test("results for refused credentials never carry the value or a path", () => {
    const value = planted(`${secret} `, 0o644);
    const result = loadRuntimeHomeCredentialValue(value, name);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(value);
  });
});

describe("writing a Runtime home credential", () => {
  test("creates an owner-only directory and file atomically, leaving no temporary file", () => {
    const value = home();
    writeRuntimeHomeCredential(value, name, Buffer.from(`${secret}\n`));
    expect(statSync(join(value, "credentials")).mode & 0o777).toBe(0o700);
    expect(statSync(join(value, "credentials", name)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(value, "credentials", name), "utf8")).toBe(secret);
    expect(readdirSync(join(value, "credentials"))).toEqual([name]);
    expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
      state: "present",
      value: secret,
    });

    writeRuntimeHomeCredential(value, name, Buffer.from("replacement-value"));
    expect(readFileSync(join(value, "credentials", name), "utf8")).toBe(
      "replacement-value",
    );
    expect(readdirSync(join(value, "credentials"))).toEqual([name]);
  });

  test("the file is owner-only even under a permissive umask", () => {
    const value = home();
    const previous = process.umask(0o000);
    try {
      writeRuntimeHomeCredential(value, name, Buffer.from(secret));
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(value, "credentials")).mode & 0o077).toBe(0);
    expect(statSync(join(value, "credentials", name)).mode & 0o077).toBe(0);
  });

  test("refuses malformed input without writing or echoing it", () => {
    const value = home();
    const error = errorFrom(() =>
      writeRuntimeHomeCredential(value, name, Buffer.from(`${secret} extra`)),
    );
    expect(error.code).toBe("CREDENTIAL_MALFORMED");
    expect(error.message).not.toContain(secret);
    expect(existsSync(join(value, "credentials", name))).toBe(false);
  });

  test("refuses an insecure directory instead of repairing it", () => {
    const value = home();
    mkdirSync(join(value, "credentials"), { mode: 0o755 });
    chmodSync(join(value, "credentials"), 0o755);
    const error = errorFrom(() =>
      writeRuntimeHomeCredential(value, name, Buffer.from(secret)),
    );
    expect(error.code).toBe("CREDENTIAL_DIRECTORY_INSECURE");
    expect(error.message).not.toContain(value);
    expect(existsSync(join(value, "credentials", name))).toBe(false);
  });

  test("refuses to replace a symbolic link, leaving its target untouched", () => {
    const value = home();
    mkdirSync(join(value, "credentials"), { mode: 0o700 });
    const target = join(value, "target");
    writeFileSync(target, "original");
    symlinkSync(target, join(value, "credentials", name));
    expect(
      errorFrom(() =>
        writeRuntimeHomeCredential(value, name, Buffer.from(secret)),
      ).code,
    ).toBe("CREDENTIAL_SYMLINK");
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  test("removal deletes the name, unlinks a symbolic link without following it, and reports absence", () => {
    const value = home();
    writeRuntimeHomeCredential(value, name, Buffer.from(secret));
    expect(removeRuntimeHomeCredential(value, name)).toBe(true);
    expect(removeRuntimeHomeCredential(value, name)).toBe(false);
    expect(loadRuntimeHomeCredentialValue(value, name)).toEqual({
      state: "missing",
    });

    const target = join(value, "target");
    writeFileSync(target, "kept");
    symlinkSync(target, join(value, "credentials", name));
    expect(removeRuntimeHomeCredential(value, name)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("kept");
    expect(removeRuntimeHomeCredential(home(), name)).toBe(false);
  });
});

describe("inspecting a Runtime home credential (metadata only)", () => {
  /** Every store state the loader distinguishes, each in a fresh home. */
  const fixtures: [string, () => string][] = [
    ["valid", () => planted(secret)],
    ["valid with newline", () => planted(`${secret}\r\n`)],
    ["missing directory", () => home()],
    [
      "missing file",
      () => {
        const value = home();
        mkdirSync(join(value, "credentials"), { mode: 0o700 });
        return value;
      },
    ],
    ["malformed", () => planted(`${secret} tail`)],
    ["NUL", () => planted(`${secret}\0`)],
    ["empty", () => planted("")],
    ["insecure file", () => planted(secret, 0o644)],
    [
      "insecure directory",
      () => {
        const value = planted(secret);
        chmodSync(join(value, "credentials"), 0o755);
        return value;
      },
    ],
    [
      "symbolic link",
      () => {
        const value = home();
        mkdirSync(join(value, "credentials"), { mode: 0o700 });
        writeFileSync(join(value, "elsewhere"), secret, { mode: 0o600 });
        symlinkSync(join(value, "elsewhere"), join(value, "credentials", name));
        return value;
      },
    ],
    [
      "too large",
      () => planted("a".repeat(maximumProviderCredentialBytes + 3)),
    ],
  ];

  test.each(fixtures)(
    "reports the same state and issue as loading, without a value (%s)",
    (_label, fixture) => {
      const value = fixture();
      const inspection = inspectRuntimeHomeCredential(value, name);
      const loaded = loadRuntimeHomeCredentialValue(value, name);
      expect(inspection).toEqual(
        loaded.state === "present" ? { state: "present" } : loaded,
      );
      expect(
        Object.keys(inspection).every((key) =>
          ["state", "issue"].includes(key),
        ),
      ).toBe(true);
      const rendered = JSON.stringify(inspection);
      for (const derived of [
        secret,
        value,
        join(value, "credentials"),
        String(secret.length),
        createHash("sha256").update(secret).digest("hex").slice(0, 12),
      ])
        expect(rendered).not.toContain(derived);
    },
  );

  test("never decodes the credential bytes into a string", () => {
    const value = planted(`${secret}\n`);
    const toString = vi.spyOn(Buffer.prototype, "toString");
    try {
      expect(inspectRuntimeHomeCredential(value, name)).toEqual({
        state: "present",
      });
      expect(toString).not.toHaveBeenCalled();
      // The loader, by contrast, is the one place that decodes.
      loadRuntimeHomeCredentialValue(value, name);
      expect(toString).toHaveBeenCalled();
    } finally {
      toString.mockRestore();
    }
  });

  test("the inspection type has no value to read", () => {
    const inspection: RuntimeHomeCredentialInspection =
      inspectRuntimeHomeCredential(planted(secret), name);
    if (inspection.state === "present") {
      // @ts-expect-error a metadata-only inspection never carries a value
      expect(inspection.value).toBeUndefined();
    }
    expect(inspection.state).toBe("present");
  });
});
