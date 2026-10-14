import assert from "node:assert/strict";
import test from "node:test";
import { validateIntake } from "./intake";

test("requires the pasted job description, resume, and acknowledgement", () => {
  const errors = validateIntake({
    jobDescription: "   ",
    resume: "   ",
    acknowledged: false,
  });

  assert.deepEqual(errors, {
    job: "Cole a descrição completa da vaga.",
    resume: "Cole o texto do seu currículo.",
    acknowledged: "Confirme que leu o aviso sobre o uso dos dados.",
  });
});

test("accepts a pasted job description and resume", () => {
  const errors = validateIntake({
    jobDescription: "Vaga para pessoa desenvolvedora",
    resume: "Experiência profissional",
    acknowledged: true,
  });

  assert.deepEqual(errors, {});
});
