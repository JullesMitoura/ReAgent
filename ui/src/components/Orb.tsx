import { useEffect, useRef } from "react";

/** Estado do agente refletido na cor do orb. */
export type OrbTone = "neutral" | "coding" | "done" | "error";

interface OrbProps {
  className?: string;
  /** Ativa a animacao de reacao (A + B -> C) dentro da esfera. Use so na marca grande. */
  reaction?: boolean;
  /** Tinge o orb conforme o estado: coding=azul, done=verde, error=vermelho, neutral=lavanda. */
  tone?: OrbTone;
}

type Reagent = { hi: string; mid: string; edge: string; glow: string };

// A azul + B laranja se fundem no produto: um brilho quente difuso (pessego),
// que some na membrana lavanda como no orb original
const A_COLOR: Reagent = { hi: "#cfe3ff", mid: "#7fb4f0", edge: "#5a8fd6", glow: "rgba(110,160,230,0.28)" };
const B_COLOR: Reagent = { hi: "#ffe0c2", mid: "#f7b477", edge: "#e8944e", glow: "rgba(235,150,90,0.26)" };

// ritmo do ciclo (segundos)
const T_TOG = 4.2; // duas esferas se aproximando devagar
const T_MRG = 1.0; // fusao A,B -> C: dissolucao lenta e suave
const T_PRD = 3.0; // o produto C existe e segue em movimento
const T_SPL = 1.0; // C se divide em A,B
const PERIOD = T_TOG + T_MRG + T_PRD + T_SPL;

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smooth01 = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Desenha uma esfera 3D suave. */
function drawSphere(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: Reagent, alpha = 1) {
  if (r <= 0.2 || alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = c.glow;
  ctx.shadowBlur = r * 0.9;
  const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.38, r * 0.1, x, y, r);
  g.addColorStop(0, "rgba(255,255,255,0.5)");
  g.addColorStop(0.28, c.hi);
  g.addColorStop(0.62, c.mid);
  g.addColorStop(1, c.edge);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Produto da reacao: brilho quente e difuso que se dissolve na membrana lavanda. */
function drawProduct(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  if (r <= 0.2 || alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = "rgba(250,200,150,0.35)";
  ctx.shadowBlur = r * 0.6;
  // realce quente levemente deslocado (embaixo/esquerda), fundindo em transparente
  const g = ctx.createRadialGradient(x - r * 0.18, y + r * 0.12, r * 0.05, x, y, r);
  g.addColorStop(0, "rgba(255,242,220,0.95)");
  g.addColorStop(0.45, "rgba(249,201,150,0.82)");
  g.addColorStop(1, "rgba(249,196,140,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function Orb({ className = "h-8 w-8", reaction = false, tone = "neutral" }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!reaction) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const orbEl = canvas.parentElement as HTMLElement | null; // a membrana externa

    let W = 0;
    let H = 0;
    let unit = 0;
    let cx = 0;
    let cy = 0;
    let partR = 0; // raio de um reagente
    let prodR = 0; // raio do produto C
    let drift = 0; // amplitude do deslize organico do conjunto
    let maxSep = 0; // afastamento maximo entre os reagentes

    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      unit = Math.min(W, H);
      cx = W / 2;
      cy = H / 2;
      partR = unit * 0.14;
      prodR = unit * 0.24;
      drift = unit * 0.06;
      maxSep = unit * 0.15;
    };
    measure();

    // direcao e forca da repulsao, sorteadas a cada ciclo no momento da fusao
    let axisPeriod = -1;
    let repAngle = Math.random() * Math.PI * 2;
    let repStrength = 1.5;

    /** Desenha um quadro no tempo dado (segundos). */
    const render = (t: number) => {
      ctx.clearRect(0, 0, W, H);
      const c = t % PERIOD;

      // sorteia direcao/forca da repulsao uma vez por ciclo, ainda na fusao (sep=0),
      // entao a troca de eixo so aparece quando as esferas de fato se separam
      const periodIdx = Math.floor(t / PERIOD);
      if (periodIdx !== axisPeriod && c >= T_TOG) {
        axisPeriod = periodIdx;
        repAngle = Math.random() * Math.PI * 2;
        repStrength = 1.75 + Math.random() * 0.6;
      }

      // separacao (sep) e crossfade reagentes<->produto ao longo do ciclo
      let sep: number;
      let ra: number; // alpha dos reagentes
      let ca: number; // alpha do produto
      if (c < T_TOG) {
        // orbitam afastados e so no fim se aproximam, bem devagar
        sep = 1 - smooth01((c / T_TOG - 0.35) / 0.65);
        ra = 1;
        ca = 0;
      } else if (c < T_TOG + T_MRG) {
        const m = smooth01((c - T_TOG) / T_MRG);
        sep = 0;
        ra = 1 - m;
        ca = m;
      } else if (c < T_TOG + T_MRG + T_PRD) {
        sep = 0;
        ra = 0;
        ca = 1;
      } else {
        // separacao com overshoot: repele forte ate repStrength e relaxa para 1
        const s = clamp01((c - (T_TOG + T_MRG + T_PRD)) / T_SPL);
        // disparo rapido para fora ate repStrength, depois relaxa para 1
        sep =
          s < 0.3
            ? repStrength * smooth01(s / 0.3)
            : repStrength + (1 - repStrength) * smooth01((s - 0.3) / 0.7);
        const e = smooth01(s);
        ra = e;
        ca = 1 - e;
      }

      // centro do conjunto desliza de forma organica (o produto herda esse movimento)
      const mx = cx + drift * Math.sin(t * 0.5) + drift * 0.6 * Math.sin(t * 0.83 + 2.1);
      const my = cy + drift * 0.9 * Math.sin(t * 0.63 + 1.7);
      // eixo A-B: direcao aleatoria do ciclo, com leve rotacao continua
      const rel = repAngle + t * 0.35;
      const d = sep * maxSep;
      const ax = mx + Math.cos(rel) * d;
      const ay = my + Math.sin(rel) * d * 0.85;
      const bx = mx - Math.cos(rel) * d;
      const by = my - Math.sin(rel) * d * 0.85;

      // a repulsao deforma a membrana externa no eixo A-B (compoe com orb-morph)
      if (orbEl) {
        const bulge = Math.max(0, sep - 1.05);
        if (bulge > 0.002) {
          const st = bulge * 0.34;
          orbEl.style.transform = `rotate(${rel}rad) scale(${1 + st}, ${1 - st * 0.55}) rotate(${-rel}rad)`;
        } else if (orbEl.style.transform) {
          orbEl.style.transform = "";
        }
      }

      drawSphere(ctx, ax, ay, partR, A_COLOR, ra);
      drawSphere(ctx, bx, by, partR, B_COLOR, ra);
      if (ca > 0.01) {
        // dissolucao suave: o brilho quente surge quase pronto, so um leve respiro
        const pulse = 1 + 0.03 * Math.sin(t * 1.6);
        drawProduct(ctx, mx, my, prodR * pulse * (0.85 + 0.15 * ca), ca);
      }
    };

    let raf = 0;
    let start = 0;
    const frame = (now: number) => {
      if (!start) start = now;
      render((now - start) / 1000);
      raf = requestAnimationFrame(frame);
    };

    if (reduce) {
      render(T_TOG * 0.2); // quadro estatico com as duas esferas
    } else {
      raf = requestAnimationFrame(frame);
    }

    const ro = new ResizeObserver(measure);
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [reaction]);

  const toneClass = tone !== "neutral" ? ` orb-${tone}` : "";
  return (
    <div className={`orb${toneClass} ${className}`} aria-hidden="true">
      {reaction ? <canvas ref={canvasRef} className="orb-canvas" /> : <span className="orb-core" />}
    </div>
  );
}
