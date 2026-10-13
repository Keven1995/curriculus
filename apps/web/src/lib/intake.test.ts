import assert from "node:assert/strict";
import test from "node:test";
import { validateIntake } from "./intake";

test("requires at least one source of job information", () => {
  const errors = validateIntake({
    jobUrl: "",
    jobDescription: "   ",
    resume: "Experiência profissional",
    acknowledged: true,
  });

  assert.equal(errors.job, "Informe o link ou a descrição da vaga.");
});

test("accepts a job description without a link", () => {
  const errors = validateIntake({
    jobUrl: "",
    jobDescription: "Vaga para pessoa desenvolvedora",
    resume: "Experiência profissional",
    acknowledged: true,
  });

  assert.deepEqual(errors, {});
});

test("rejects links that are not HTTP or HTTPS URLs", () => {
  const errors = validateIntake({
    jobUrl: "javascript:alert(1)",
    jobDescription: "",
    resume: "Experiência profissional",
    acknowledged: true,
  });

  assert.equal(errors.job, "Use um link válido iniciado por http:// ou https://.");
});

test("requires resume text and acknowledgement of the data notice", () => {
  const errors = validateIntake({
    jobUrl: "https://example.com/vaga",
    jobDescription: "",
    resume: "   ",
    acknowledged: false,
  });

  assert.equal(errors.resume, "Cole o texto do seu currículo.");
  assert.equal(errors.acknowledged, "Confirme que leu o aviso sobre o uso dos dados.");
});

test("accepts a valid HTTP link and resume", () => {
  const errors = validateIntake({
    jobUrl: "https://example.com/vaga",
    jobDescription: "",
    resume: "Experiência profissional",
    acknowledged: true,
  });

  assert.deepEqual(errors, {});
});
