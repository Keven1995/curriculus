import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteImportedLayout,
  importReferencePdf,
  ResumeLayoutClientError,
} from "./resume-layout-client";

const templateResponse = {
  templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
  resumeText: "Texto extraído com segurança.",
  layoutAvailable: true,
  expiresAt: "2026-01-02T00:00:00.000Z",
};

test("uploads a PDF as raw bytes and receives only extracted text plus an opaque layout handle", async () => {
  let calls = 0;
  let uploadBody: unknown;
  let uploadHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    calls += 1;
    uploadBody = init?.body;
    uploadHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(templateResponse), { status: 201 });
  };

  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1])], "referencia.pdf", { type: "application/pdf" });
  const result = await importReferencePdf(file, { apiBaseUrl: "http://127.0.0.1:4000", fetcher });

  assert.equal(calls, 1);
  assert.equal(result.templateId, templateResponse.templateId);
  assert.equal(result.resumeText, templateResponse.resumeText);
  assert.equal(result.layoutAvailable, true);
  assert.deepEqual(result.layoutWarnings, []);
  assert.equal(uploadHeaders?.get("content-type"), "application/pdf");
  assert.equal(uploadHeaders?.get("x-file-name"), "referencia.pdf");
  assert.deepEqual(Array.from(uploadBody as Uint8Array), [0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
});

test("accepts a text extraction with no reproducible reference layout", async () => {
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1])], "simple.pdf", { type: "application/pdf" });
  const result = await importReferencePdf(file, {
    fetcher: async () => new Response(JSON.stringify({
      resumeText: "Texto preservado.",
      layoutAvailable: false,
      expiresAt: "2026-01-02T00:00:00.000Z",
    }), { status: 201 }),
  });
  assert.equal(result.resumeText, "Texto preservado.");
  assert.equal(result.layoutAvailable, false);
  assert.equal(result.templateId, undefined);
});

test("rejects fake PDFs before upload", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    return new Response();
  };
  const fakeFile = new File(["not pdf"], "bad.pdf", { type: "application/pdf" });
  await assert.rejects(importReferencePdf(fakeFile, { fetcher }), (error: unknown) =>
    error instanceof ResumeLayoutClientError && error.code === "INVALID_PDF");
  assert.equal(calls, 0);

  assert.equal(calls, 0);
});

test("deletes imported template data through its opaque ID", async () => {
  let requestedUrl = "";
  const fetcher: typeof fetch = async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init?.method, "DELETE");
    return new Response(null, { status: 204 });
  };

  await deleteImportedLayout(templateResponse.templateId, { apiBaseUrl: "http://127.0.0.1:4000", fetcher });
  assert.equal(requestedUrl, `http://127.0.0.1:4000/resume-layouts/${templateResponse.templateId}`);
});
