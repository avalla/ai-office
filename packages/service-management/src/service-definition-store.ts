import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Filesystem boundary for generated service definitions.
 *
 * Kept behind an interface so adapter tests can exercise collision, update and
 * removal behaviour without a real systemd or launchd installation.
 */
export interface ServiceDefinitionStore {
  /** Returns `null` when nothing exists at the path. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export class LocalServiceDefinitionStore implements ServiceDefinitionStore {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Writes through a temporary file in the same directory.
   *
   * A service manager may read the directory at any moment; a partially
   * written unit is a unit that means something other than what was planned,
   * so the file becomes visible only once it is complete.
   */
  async write(path: string, content: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}
