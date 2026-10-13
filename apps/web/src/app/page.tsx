"use client";

import styles from "./page.module.css";
import { AnalysisFlow } from "../components/AnalysisFlow";

export default function HomePage() {
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

      <AnalysisFlow
        styles={styles}
        apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
      />

      <footer className={styles.footer}>
        <span>Curriculus — uma ferramenta de apoio, não uma promessa de contratação.</span>
        <a href="#aviso-de-dados">Aviso sobre os dados</a>
      </footer>
    </main>
  );
}
