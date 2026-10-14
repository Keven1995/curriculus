"use client";

import { motion } from "motion/react";
import {
  ArrowDown,
  ArrowRight,
  Check,
  FileText,
  LockKeyhole,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BlurText } from "@/components/react-bits/BlurText";
import { SpotlightCard } from "@/components/aceternity/SpotlightCard";
import { cn } from "@/lib/utils";
import styles from "@/app/page.module.css";

export function HomeHero() {
  return (
    <section className={styles.hero} id="inicio" aria-labelledby="page-title">
      <motion.div
        className={styles.heroCopy}
        initial={false}
        animate={{ opacity: 1, y: 0 }}
      >
        <Badge variant="secondary" className={styles.heroBadge}>
          <Sparkles aria-hidden="true" />
          UMA REVISÃO QUE CONTINUA SENDO SUA
        </Badge>

        <h1 id="page-title">
          Um currículo mais alinhado à vaga.
          <span className={styles.heroAccent}>
            <BlurText text="Fiel à sua experiência." delay={0.42} />
          </span>
        </h1>

        <p className={styles.intro}>
          Dê destaque ao que você já fez. Compare sua trajetória com a oportunidade,
          revise cada sugestão e escolha o que representa você.
        </p>

        <div className={styles.heroActions}>
          <a
            className={cn(buttonVariants({ size: "lg" }), styles.heroCta)}
            href="#analysis-form"
          >
            Começar minha análise
            <ArrowRight aria-hidden="true" />
          </a>
          <span className={styles.heroActionNote}>Sem cobrança para revisar as sugestões</span>
        </div>

        <div className={styles.heroPromises} aria-label="Compromissos do Curriculus">
          <span><Check aria-hidden="true" /> Sem inventar conquistas</span>
          <span><LockKeyhole aria-hidden="true" /> Seus dados, com cuidado</span>
        </div>
      </motion.div>

      <motion.div
        className={styles.heroVisual}
        initial={false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
      >
        <div className={styles.visualOrbit} aria-hidden="true" />
        <SpotlightCard className={styles.heroSpotlight}>
          <Card className={styles.resumeCard}>
            <CardHeader className={styles.resumeCardHeader}>
              <div className={styles.resumeFileIcon} aria-hidden="true">
                <FileText />
              </div>
              <div className={styles.resumeCardHeading}>
                <Badge variant="outline" className={styles.exampleBadge}>EXEMPLO DE REVISÃO</Badge>
                <CardTitle className={styles.resumeCardTitle}>Experiência profissional</CardTitle>
              </div>
              <span className={styles.resumePageNumber}>01</span>
            </CardHeader>

            <CardContent className={styles.resumeCardContent}>
              <div className={styles.resumeSnippet}>
                <span className={styles.snippetLabel}>SEU TEXTO</span>
                <p>Atuação em projetos de tecnologia e desenvolvimento de soluções.</p>
              </div>
              <div className={styles.suggestionConnector} aria-hidden="true">
                <span />
                <ArrowDown />
                <span />
              </div>
              <div className={`${styles.resumeSnippet} ${styles.suggestedSnippet}`}>
                <span className={styles.snippetLabel}><WandSparkles aria-hidden="true" /> SUGESTÃO</span>
                <p>Experiência em projetos de tecnologia, com foco no desenvolvimento de soluções.</p>
              </div>
              <p className={styles.sourceNote}>
                <Check aria-hidden="true" /> Reescrita sem acrescentar fatos
              </p>
            </CardContent>
          </Card>

          <div className={styles.spotlightFooter}>
            <span className={styles.footerSparkle}><Sparkles aria-hidden="true" /></span>
            <span><strong>Você decide.</strong> Nada muda sem a sua aprovação.</span>
          </div>
        </SpotlightCard>

        <motion.div
          className={styles.priceFloat}
          initial={false}
          animate={{ opacity: 1, x: 0 }}
        >
          <span className={styles.priceFloatIcon}><Check aria-hidden="true" /></span>
          <span><strong>R$ 1,99</strong><small>somente se quiser o PDF final</small></span>
        </motion.div>
      </motion.div>
    </section>
  );
}
