export type IntakeInput = {
  jobUrl: string;
  jobDescription: string;
  resume: string;
  acknowledged: boolean;
};

export type IntakeErrors = Partial<
  Record<"job" | "resume" | "acknowledged", string>
>;

export function validateIntake(input: IntakeInput): IntakeErrors {
  const errors: IntakeErrors = {};
  const jobUrl = input.jobUrl.trim();

  if (!jobUrl && !input.jobDescription.trim()) {
    errors.job = "Informe o link ou a descrição da vaga.";
  } else if (jobUrl) {
    try {
      const url = new URL(jobUrl);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname
      ) {
        errors.job = "Use um link válido iniciado por http:// ou https://.";
      }
    } catch {
      errors.job = "Use um link válido iniciado por http:// ou https://.";
    }
  }

  if (!input.resume.trim()) {
    errors.resume = "Cole o texto do seu currículo.";
  }

  if (!input.acknowledged) {
    errors.acknowledged = "Confirme que leu o aviso sobre o uso dos dados.";
  }

  return errors;
}
