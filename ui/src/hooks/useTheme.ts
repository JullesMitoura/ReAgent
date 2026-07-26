import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "reagent-theme";

function readInitialTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/**
 * Tema claro/escuro. A classe `.light` na <html> (aplicada cedo pelo script
 * inline em index.html, para evitar flash) é a fonte da verdade inicial;
 * daqui em diante este hook mantém a classe e o localStorage em sincronia.
 * Sem preferência salva, segue a mudança do tema do sistema operacional.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
  }, [theme]);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* localStorage indisponível (modo privado): tema fica só em memória */
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
