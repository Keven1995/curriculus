export type IntakeInput = {
  jobDescription: string;
  resume: string;
  acknowledged: boolean;
};

export type IntakeErrors = Partial<
  Record<"job" | "resume" | "acknowledged", string>
>;

export function validateIntake(input: IntakeInput): IntakeErrors {
  const errors: IntakeErrors = {};
  if (!input.jobDescription.trim()) errors.job = "Cole a descrição completa da vaga.";

  if (!input.resume.trim()) {
    errors.resume = "Cole o texto do seu currículo.";
  }

  if (!input.acknowledged) {
    errors.acknowledged = "Confirme que leu o aviso sobre o uso dos dados.";
  }

  return errors;
}
