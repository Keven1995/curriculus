"use client";

import { motion } from "motion/react";
import styles from "./blur-text.module.css";

type BlurTextProps = {
  text: string;
  className?: string;
  delay?: number;
};

/** React Bits-inspired word reveal, kept local so motion stays accessible and lightweight. */
export function BlurText({ text, className, delay = 0.3 }: BlurTextProps) {
  const words = text.split(" ");

  return (
    <span className={className}>
      {words.map((word, index) => (
        <motion.span
          key={`${word}-${index}`}
          className={styles.word}
          initial={false}
          animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
          style={{ display: "inline-block", animationDelay: `${delay + index * 0.055}s` }}
        >
          {word}{index < words.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </span>
  );
}
