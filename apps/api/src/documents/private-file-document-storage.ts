import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DOCUMENT_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i;

export interface PrivateDocumentStorage {
  write(key: string, contents: Buffer): Promise<void>;
  read(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class PrivateFileDocumentStorage implements PrivateDocumentStorage {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory.trim()) throw new Error("A private document directory is required.");
    this.directory = resolve(directory);
  }

  private pathFor(key: string): string {
    if (!DOCUMENT_KEY_PATTERN.test(key)) throw new Error("Invalid private document key.");
    return join(this.directory, key);
  }

  async write(key: string, contents: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  }

  async read(key: string): Promise<Buffer | null> {
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<Array<{ key: string; modifiedAt: Date }>> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const files: Array<{ key: string; modifiedAt: Date }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !DOCUMENT_KEY_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await stat(join(this.directory, entry.name));
        files.push({ key: entry.name, modifiedAt: metadata.mtime });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return files;
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    try {
      await unlink(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
