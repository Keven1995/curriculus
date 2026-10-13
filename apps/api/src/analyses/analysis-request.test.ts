import assert from "node:assert/strict";
import test from "node:test";
import { validateAnalysisRequest } from "./analysis-request.js";

const validRequest = {
  jobDescription: "Pessoa desenvolvedora TypeScript",
  resume: "Experiência com desenvolvimento de software",
  dataNoticeAcknowledged: true,
};

test("accepts a description and resume and returns normalized input", () => {
  const result = validateAnalysisRequest({
    ...validRequest,
    jobDescription: "  Vaga para pessoa desenvolvedora  ",
    resume: "  Experiência profissional  ",
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data, {
      jobDescription: "Vaga para pessoa desenvolvedora",
      resume: "Experiência profissional",
      dataNoticeAcknowledged: true,
    });
  }
});

test("accepts an HTTP(S) URL without a pasted description", () => {
  const result = validateAnalysisRequest({
    jobUrl: "https://example.com/jobs/123",
    resume: validRequest.resume,
    dataNoticeAcknowledged: true,
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.jobUrl, "https://example.com/jobs/123");
    assert.equal(result.data.jobDescription, undefined);
  }
});

test("requires job information, resume text, and acknowledgement", () => {
  const result = validateAnalysisRequest({
    jobUrl: " ",
    jobDescription: "\n",
    resume: " ",
    dataNoticeAcknowledged: false,
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.issues, [
      { field: "job", code: "required" },
      { field: "resume", code: "required" },
      { field: "dataNoticeAcknowledged", code: "required" },
    ]);
  }
});

test("rejects invalid URL schemes and embedded credentials", () => {
  for (const jobUrl of ["javascript:alert(1)", "ftp://example.com/job", "https://user:pass@example.com/job"]) {
    const result = validateAnalysisRequest({
      jobUrl,
      resume: validRequest.resume,
      dataNoticeAcknowledged: true,
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.issues.some((issue) => issue.field === "jobUrl"));
    }
  }
});

test("rejects malformed input types and unknown fields", () => {
  for (const input of [null, [], "text", 42]) {
    assert.equal(validateAnalysisRequest(input).success, false);
  }

  const result = validateAnalysisRequest({
    ...validRequest,
    debug: "unexpected value",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.issues.some((issue) => issue.code === "unknown_field"));
  }

  const invalidFieldTypes = validateAnalysisRequest({
    jobUrl: 12,
    jobDescription: true,
    resume: validRequest.resume,
    dataNoticeAcknowledged: "yes",
  });
  assert.equal(invalidFieldTypes.success, false);
  if (!invalidFieldTypes.success) {
    assert.deepEqual(
      invalidFieldTypes.issues.map(({ field, code }) => ({ field, code })),
      [
        { field: "jobUrl", code: "invalid_type" },
        { field: "jobDescription", code: "invalid_type" },
        { field: "job", code: "required" },
        { field: "dataNoticeAcknowledged", code: "invalid_type" },
      ],
    );
  }
});

test("enforces the approved per-field character limits", () => {
  const urlPrefix = "https://e.com/";
  const atLimitUrl = `${urlPrefix}${"a".repeat(2_048 - Array.from(urlPrefix).length)}`;
  const atLimits = validateAnalysisRequest({
    jobUrl: atLimitUrl,
    jobDescription: "j".repeat(60_000),
    resume: "r".repeat(80_000),
    dataNoticeAcknowledged: true,
  });
  const tooLongResume = validateAnalysisRequest({
    ...validRequest,
    resume: "r".repeat(80_001),
  });
  const tooLongDescription = validateAnalysisRequest({
    ...validRequest,
    jobDescription: "j".repeat(60_001),
  });
  const tooLongUrl = validateAnalysisRequest({
    jobUrl: `${atLimitUrl}a`,
    resume: validRequest.resume,
    dataNoticeAcknowledged: true,
  });

  assert.equal(atLimits.success, true);
  assert.equal(tooLongResume.success, false);
  assert.equal(tooLongDescription.success, false);
  assert.equal(tooLongUrl.success, false);
});

test("counts Unicode code points for character limits", () => {
  const result = validateAnalysisRequest({
    jobDescription: "vaga",
    resume: "😀".repeat(80_000),
    dataNoticeAcknowledged: true,
  });

  assert.equal(result.success, true);
});
