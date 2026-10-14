"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import styles from "./spotlight-card.module.css";

type SpotlightCardProps = {
  children: ReactNode;
  className?: string;
};

/** Aceternity-inspired cursor spotlight, with a static fallback for reduced motion/touch. */
export function SpotlightCard({ children, className = "" }: SpotlightCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(-500);
  const y = useMotionValue(-500);
  const backgroundImage = useMotionTemplate`
    radial-gradient(440px circle at ${x}px ${y}px, rgb(151 235 194 / 18%), transparent 72%)
  `;

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (reduceMotion) return;
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    x.set(event.clientX - bounds.left);
    y.set(event.clientY - bounds.top);
  }

  return (
    <motion.div
      ref={root}
      className={`${styles.spotlightCard} ${className}`}
      style={{ backgroundImage }}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        x.set(-500);
        y.set(-500);
      }}
    >
      <div className={styles.spotlightContent}>{children}</div>
    </motion.div>
  );
}
