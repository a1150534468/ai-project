import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { pageEnter } from "./variants";

export function PageTransition({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 0, overflow: "hidden" }}>
      <AnimatePresence mode="wait">
        <motion.div
          key={viewKey}
          variants={pageEnter}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minHeight: 0, overflowX: "hidden", overflowY: "auto" }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
