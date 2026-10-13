"use client";

import { useState, type FormEvent } from "react";
import styles from "./page.module.css";
import { validateIntake, type IntakeInput } from "../lib/intake";

const emptyForm: IntakeInput = {
  jobUrl: "",
  jobDescription: "",
  resume: "",
  acknowledged: false,
};

export default function HomePage() {
  const [form, setForm] = useState<IntakeInput>(emptyForm);
  const [errors, setErrors] = useState<ReturnType<typeof validateIntake>>({});
  const [status, setStatus] = useState("");

  function updateForm<K extends keyof IntakeInput>(
    field: K,
    value: IntakeInput[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors({});
    setStatus("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationErrors = validateIntake(form);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      setStatus("Revise os campos indicados antes de continuar.");
      return;
    }

    setStatus(
      "Informações validadas neste navegador. Nenhum dado foi enviado ou salvo.",
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="#inicio" aria-label="Curriculus, início">
          <span className={styles.brandMark} aria-hidden="true">C</span>
          Curriculus
        </a>
        <span className={styles.headerNote}>Seu currículo, sua história.</span>
      </header>

      <section className={styles.hero} id="inicio" aria-labelledby="page-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>PREPARE-SE PARA A PRÓXIMA OPORTUNIDADE</p>
          <h1 id="page-title">Um currículo mais alinhado à vaga. Sempre fiel à sua história.</h1>
          <p className={styles.intro}>
            Compare os requisitos da oportunidade com o que você já viveu na sua
            carreira. Você revisa cada sugestão e decide o que faz sentido.
          </p>
          <ul className={styles.benefits}>
            <li><span aria-hidden="true">✓</span> Sem inventar experiências ou resultados</li>
            <li><span aria-hidden="true">✓</span> Você revisa antes de decidir</li>
            <li><span aria-hidden="true">✓</span> Sem promessa de entrevista ou contratação</li>
          </ul>
        </div>

        <aside className={styles.priceCard} aria-label="Preço do serviço">
          <span className={styles.priceLabel}>Só paga se quiser o currículo final</span>
          <strong>R$ 1,99</strong>
          <span>após revisar as sugestões</span>
        </aside>
      </section>

      <section className={styles.formSection} aria-labelledby="form-title">
        <div className={styles.sectionHeading}>
          <span className={styles.step}>01</span>
          <div>
            <h2 id="form-title">Vamos começar pelo contexto</h2>
            <p>Informe a vaga e cole seu currículo para comparar.</p>
          </div>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label htmlFor="job-url">Link da vaga <span>(opcional)</span></label>
            <input
              id="job-url"
              type="url"
              inputMode="url"
              placeholder="https://empresa.com/vaga"
              value={form.jobUrl}
              onChange={(event) => updateForm("jobUrl", event.target.value)}
              aria-invalid={Boolean(errors.job)}
              aria-describedby={errors.job ? "job-help job-error" : "job-help"}
            />
            <p className={styles.help} id="job-help">
              Alguns sites podem bloquear o acesso. Se isso acontecer, cole a descrição abaixo.
            </p>
            {errors.job && <p className={styles.error} id="job-error">{errors.job}</p>}
          </div>

          <div className={styles.field}>
            <label htmlFor="job-description">Descrição da vaga <span>(link ou descrição é necessário)</span></label>
            <textarea
              id="job-description"
              rows={5}
              placeholder="Cole aqui as responsabilidades e os requisitos da oportunidade..."
              value={form.jobDescription}
              onChange={(event) => updateForm("jobDescription", event.target.value)}
              aria-invalid={Boolean(errors.job)}
              aria-describedby={errors.job ? "job-description-error" : undefined}
            />
            {errors.job && <p className={styles.error} id="job-description-error">{errors.job}</p>}
          </div>

          <div className={styles.field}>
            <label htmlFor="resume">Seu currículo em texto</label>
            <textarea
              id="resume"
              rows={9}
              placeholder="Cole seu currículo aqui. Você pode incluir experiências, formação e competências relevantes..."
              value={form.resume}
              onChange={(event) => updateForm("resume", event.target.value)}
              aria-invalid={Boolean(errors.resume)}
              aria-describedby={errors.resume ? "resume-help resume-error" : "resume-help"}
            />
            <p className={styles.help} id="resume-help">
              Evite incluir CPF, RG, endereço residencial, dados bancários, informações sensíveis ou dados de outras pessoas.
            </p>
            {errors.resume && <p className={styles.error} id="resume-error">{errors.resume}</p>}
          </div>

          <aside className={styles.privacyNotice} id="aviso-de-dados" aria-labelledby="privacy-title">
            <span className={styles.privacyIcon} aria-hidden="true">i</span>
            <div>
              <h3 id="privacy-title">Seus dados devem servir apenas a este objetivo</h3>
              <p>
                O produto foi definido para usar vaga e currículo na criação das sugestões e do documento solicitado — não para vender dados, treinar IA ou avaliar sua empregabilidade. Fornecedores necessários poderão processar os dados para prestar o serviço. Os avisos legais completos e os prazos de retenção ainda precisam ser finalizados antes do lançamento.
              </p>
              <p className={styles.prototypeNote}>
                Esta versão é apenas uma demonstração: não envia, analisa nem salva o conteúdo digitado.
              </p>
            </div>
          </aside>

          <div className={styles.consentField}>
            <input
              id="acknowledged"
              type="checkbox"
              checked={form.acknowledged}
              onChange={(event) => updateForm("acknowledged", event.target.checked)}
              aria-invalid={Boolean(errors.acknowledged)}
              aria-describedby={errors.acknowledged ? "acknowledgement-error" : undefined}
            />
            <label htmlFor="acknowledged">
              Li o aviso sobre o uso dos dados e confirmo que não incluí informações sensíveis desnecessárias ou dados de terceiros.
            </label>
          </div>
          {errors.acknowledged && (
            <p className={styles.error} id="acknowledgement-error">{errors.acknowledged}</p>
          )}

          <button className={styles.submitButton} type="submit">
            Validar informações <span aria-hidden="true">→</span>
          </button>
          <p className={styles.submitNote}>
            A análise ainda não está ativa. Nenhum pagamento será solicitado nesta demonstração.
          </p>
          <p className={styles.status} role="status" aria-live="polite">{status}</p>
        </form>
      </section>

      <footer className={styles.footer}>
        <span>Curriculus — uma ferramenta de apoio, não uma promessa de contratação.</span>
        <a href="#aviso-de-dados">Aviso sobre os dados</a>
      </footer>
    </main>
  );
}
