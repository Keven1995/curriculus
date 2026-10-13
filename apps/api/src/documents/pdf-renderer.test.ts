import assert from "node:assert/strict";
import test from "node:test";
import { renderResumePdf } from "./pdf-renderer.js";

test("renders a valid PDF from resume text without adding model-generated content", async () => {
  const pdf = await renderResumePdf("Desenvolvi APIs em Java.\nExperiência com SQL.");

  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 1_000);
  assert.equal(pdf.subarray(-6).toString("ascii"), "%%EOF\n");
});
