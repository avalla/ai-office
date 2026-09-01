import { describe, expect, test } from "vitest";
import {
  createPortableProjectArchive,
  parsePortableProjectArchive,
  portableStateChecksum,
  serializePortableProjectArchive,
  type PortableProjectManifest,
  type PortableProjectState,
} from "@ai-office/application/project-portability/project-snapshot.ts";

const timestamp = "2026-09-01T08:00:00.000Z";

function state(value: unknown = ["TypeScript"]): PortableProjectState {
  return {
    project: { name: "Portable", createdAt: timestamp, updatedAt: timestamp },
    tasks: [
      {
        id: "task-1",
        title: "Move machines",
        status: "pending",
        priority: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    profileEntries: [
      {
        id: "profile-1",
        category: "stack",
        key: "languages",
        value,
        origin: "detected",
        confidence: 1,
        confirmedAt: timestamp,
        createdAt: timestamp,
      },
    ],
    officeManifests: [],
    governance: {
      milestones: [],
      requirements: [],
      adrs: [],
      reviews: [],
      approvals: [],
    },
    agents: { roles: [], definitions: [], terminalRuns: [] },
  };
}

function manifest(value: PortableProjectState): PortableProjectManifest {
  return {
    format: "ai-office-project",
    formatVersion: 1,
    projectIdentity: "repo_portable",
    createdAt: timestamp,
    revision: {
      id: "rev-1",
      stateChecksum: portableStateChecksum(value),
    },
    contents: [
      "project",
      "tasks",
      "profile",
      "office_manifests",
      "governance",
      "agent_definitions",
      "terminal_run_summaries",
    ],
  };
}

describe("portable project snapshot", () => {
  test("round-trips a strict versioned envelope with canonical integrity", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    const serialized = serializePortableProjectArchive(archive);
    expect(parsePortableProjectArchive(serialized)).toEqual(archive);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  test("rejects state and envelope checksum corruption", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          state: {
            ...archive.state,
            project: { ...archive.state.project, name: "Tampered" },
          },
        }),
      ),
    ).toThrow("state checksum mismatch");
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          integrity: { ...archive.integrity, checksum: "0".repeat(64) },
        }),
      ),
    ).toThrow("integrity checksum mismatch");
  });

  test("rejects unsupported formats, embedded paths, and sensitive fields", () => {
    const value = state();
    const archive = createPortableProjectArchive({
      state: value,
      manifest: manifest(value),
    });
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({
          ...archive,
          manifest: { ...archive.manifest, formatVersion: 2 },
        }),
      ),
    ).toThrow("formatVersion");
    expect(() =>
      parsePortableProjectArchive(
        JSON.stringify({ ...archive, artifacts: [{ path: "../../escape" }] }),
      ),
    ).toThrow("Unrecognized key");
    const sensitive = state({ token: "must-not-export" });
    expect(() =>
      createPortableProjectArchive({
        state: sensitive,
        manifest: manifest(sensitive),
      }),
    ).toThrow("sensitive field token");
  });
});
