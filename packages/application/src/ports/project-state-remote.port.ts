import type { PortableProjectArchive } from "../project-portability/project-snapshot.ts";

export interface RemoteProjectStateHead {
  projectIdentity: string;
  revisionId: string;
  parentRevisionId?: string;
  stateChecksum: string;
}

export interface ProjectStateRemote {
  getHead(projectIdentity: string): Promise<RemoteProjectStateHead | null>;
  pull(
    projectIdentity: string,
    revisionId?: string,
  ): Promise<PortableProjectArchive | null>;
  push(input: {
    projectIdentity: string;
    expectedHeadRevisionId: string | null;
    archive: PortableProjectArchive;
  }): Promise<
    | { outcome: "pushed"; head: RemoteProjectStateHead }
    | { outcome: "conflict"; head: RemoteProjectStateHead }
  >;
}
