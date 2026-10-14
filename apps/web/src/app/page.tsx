import { ArrowRight, FileText } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HomeHero } from "@/components/HomeHero";
import styles from "./page.module.css";
import { AnalysisFlow } from "../components/AnalysisFlow";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="#inicio" aria-label="Curriculus, início">
          <span className={styles.brandMark} aria-hidden="true"><FileText /></span>
          Curriculus
        </a>
        <div className={styles.headerActions}>
          <span className={styles.headerNote}>Seu currículo, sua história.</span>
          <a className={cn(buttonVariants({ size: "sm", variant: "outline" }), styles.headerCta)} href="#analysis-form">
            Começar <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </header>

      <HomeHero />

      <div id="analysis-form" className={styles.analysisAnchor}>
        <AnalysisFlow
          styles={styles}
          apiBaseUrl={process.env.NEXT_PUBLIC_API_URL}
        />
      </div>

      <footer className={styles.footer}>
        <span>Curriculus — uma ferramenta de apoio, não uma promessa de contratação.</span>
        <nav aria-label="Informações legais">
          <a href="#aviso-de-dados">Aviso sobre os dados</a>
          <a href="/privacidade">Privacidade (rascunho)</a>
          <a href="/termos">Termos (rascunho)</a>
        </nav>
      </footer>
    </main>
  );
}
