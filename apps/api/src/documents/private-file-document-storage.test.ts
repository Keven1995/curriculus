import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateFileDocumentStorage } from "./private-file-document-storage.js";

test("writes, reads, and deletes PDFs in the configured private directory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "curriculus-private-documents-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new PrivateFileDocumentStorage(directory);
  const key = "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea.pdf";
  const contents = Buffer.from("private pdf bytes");

  await storage.write(key, contents);
  assert.deepEqual(await storage.read(key), contents);
  await storage.delete(key);
  assert.equal(await storage.read(key), null);
});

test("rejects keys that could escape the private directory", async () => {
  const storage = new PrivateFileDocumentStorage("private-documents");

  await assert.rejects(storage.read("../public/resume.pdf"), /Invalid private document key/);
  await assert.rejects(storage.write("resume.pdf", Buffer.from("private")), /Invalid private document key/);
});
