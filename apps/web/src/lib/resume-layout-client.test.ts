import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteImportedLayout,
  importReferencePdf,
  isResumeLayoutFeatureEnabled,
  ResumeLayoutClientError,
} from "./resume-layout-client";

const templateResponse = {
  templateId: "4e4f8a8c-7c1f-4fa7-a5a5-83eb983437ea",
  template: {
    schemaVersion: "2.0",
    id: "sidebar-dark-header-color-v1",
    page: { format: "A4", widthPt: 595.28, heightPt: 841.89, marginPt: 30 },
    palette: { sidebar: "#404040", main: "#FFFFFF", headerApprox: "#A3C6C1", text: "#111111" },
    columns: { sidebarWidthPt: 170, gapPt: 20, sidebarRepeats: true },
    header: { heightPt: 140, nameUppercase: true },
    typography: { namePt: 26, sectionPt: 14, bodyPt: 10.5 },
    sections: ["summary", "experience", "education", "certifications"],
    sidebarSections: ["photo", "contact", "skills"],
    overflow: { wrapText: true, pageBreak: true, keepExperienceHeadingWithFirstBullet: true },
    detection: { confidence: 0.4, detectedColumns: 2, warnings: [] },
  },
  rawExtraction: { schema_version: "1.0", pages: [] },
  detectedSections: [],
  expiresAt: "2026-01-02T00:00:00.000Z",
};

test("checks local feature capability and uploads a PDF as raw bytes", async () => {
  let calls = 0;
  let uploadBody: unknown;
  let uploadHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    calls += 1;
    if (String(url).endsWith("/features")) return new Response(JSON.stringify({ resumeLayoutImport: true }));
    uploadBody = init?.body;
    uploadHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(templateResponse), { status: 201 });
  };

  assert.equal(await isResumeLayoutFeatureEnabled({ apiBaseUrl: "http://127.0.0.1:4000", fetcher }), true);
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1])], "referencia.pdf", { type: "application/pdf" });
  const result = await importReferencePdf(file, { apiBaseUrl: "http://127.0.0.1:4000", fetcher });

  assert.equal(calls, 2);
  assert.equal(result.templateId, templateResponse.templateId);
  assert.equal(uploadHeaders?.get("content-type"), "application/pdf");
  assert.equal(uploadHeaders?.get("x-file-name"), "referencia.pdf");
  assert.deepEqual(Array.from(uploadBody as Uint8Array), [0x25, 0x50, 0x44, 0x46, 0x2d, 1]);
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
