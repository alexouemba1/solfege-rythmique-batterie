// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

function nowMs() {
  return performance.now();
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Symbols pour l'affichage
const GLYPH = {
  Q: "♩", // noire + liaison (2 steps)
  E: "♪", // croche (1 step)
  R: "𝄽", // silence
};

const STEPS_PER_BAR = 8;

// ✅ bornes mesures
const MIN_BARS = 8;
const MAX_BARS = 16;

function isOnset(step) {
  return step === "E" || step === "Q";
}

// ✅ Génère N mesures (concat)
function generateExercise(level = 1, barsCount = MIN_BARS) {
  const safeBars = clamp(barsCount, MIN_BARS, MAX_BARS);

  const oneBar = () => {
    const steps = new Array(STEPS_PER_BAR).fill(null);

    if (level === 1) {
      for (let beat = 0; beat < 4; beat++) {
        const isRest = Math.random() < 0.25;
        steps[beat * 2] = isRest ? "R" : "Q";
        steps[beat * 2 + 1] = null; // liaison
      }
    } else if (level === 2) {
      for (let i = 0; i < STEPS_PER_BAR; i++) {
        const isRest = Math.random() < 0.3;
        steps[i] = isRest ? "R" : "E";
      }
    } else {
      let i = 0;
      while (i < STEPS_PER_BAR) {
        const roll = Math.random();
        if (roll < 0.3 && i % 2 === 0) {
          const isRest = Math.random() < 0.2;
          steps[i] = isRest ? "R" : "Q";
          steps[i + 1] = null;
          i += 2;
        } else {
          const isRest = Math.random() < 0.3;
          steps[i] = isRest ? "R" : "E";
          i += 1;
        }
      }
    }
    return steps;
  };

  const all = [];
  for (let b = 0; b < safeBars; b++) all.push(...oneBar());
  return all;
}

function formatStep(step) {
  if (step === null) return "";
  return GLYPH[step] ?? step;
}

// --- Audio buffers ---
function createClickBuffer(audioCtx, { freq = 1200, amp = 0.6, decay = 120 } = {}) {
  const sr = audioCtx.sampleRate;
  const duration = 0.03;
  const length = Math.floor(sr * duration);
  const buffer = audioCtx.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const t = i / sr;
    const env = Math.exp(-t * decay);
    data[i] = Math.sin(2 * Math.PI * freq * t) * env * amp;
  }
  return buffer;
}

// ✅ Confettis
function Confetti({ show }) {
  if (!show) return null;
  const pieces = Array.from({ length: 18 }, (_, i) => i);

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((i) => (
        <span
          key={i}
          className="confettiPiece"
          style={{
            left: `${(i * 100) / 18}%`,
            animationDelay: `${(i % 6) * 40}ms`,
          }}
        />
      ))}
    </div>
  );
}

export default function App() {
  const [bpm, setBpm] = useState(90);
  const [level, setLevel] = useState(1);

  // ✅ nb mesures
  const [barsCount, setBarsCount] = useState(MIN_BARS);

  const [isRunning, setIsRunning] = useState(false);

  // Mode attendu / libre
  const [attenduMode, setAttenduMode] = useState(true);

  // lecture des notes (hors mode écho)
  const [playNotes, setPlayNotes] = useState(true);

  // Mode Écho : listen -> play
  const [echoMode, setEchoMode] = useState(false);
  const [echoPhase, setEchoPhase] = useState("listen"); // "listen" | "play"

  // volumes
  const [volMetro, setVolMetro] = useState(0.8);
  const [volNotes, setVolNotes] = useState(0.6);

  const [exercise, setExercise] = useState(() => generateExercise(1, MIN_BARS));
  const [stepIndex, setStepIndex] = useState(0);

  const [tapHistory, setTapHistory] = useState([]);
  // ✅ stepResult suit la longueur de exercise
  const [stepResult, setStepResult] = useState(() =>
    Array(generateExercise(1, MIN_BARS).length).fill(null)
  );
  const [extrasCount, setExtrasCount] = useState(0);

  // ✅ WAOUH #1 : confettis
  const [showConfetti, setShowConfetti] = useState(false);

  // ✅ WAOUH #3 : petit “pulse” visuel quand c'est parfait
  const [showPerfect, setShowPerfect] = useState(false);

  const bannerText = useMemo(() => {
    return "On reprend au waouh #3";
  }, []);

  const audioCtxRef = useRef(null);

  const buffersRef = useRef({
    metroAccent: null,
    metroBeat: null,
    noteE: null,
    noteQ: null,
  });

  const gainsRef = useRef({
    metro: null,
    notes: null,
  });

  const timerRef = useRef({ raf: null, startPerfMs: 0 });
  const lastStepRef = useRef(-1);
  const lastStepInBarRef = useRef(-1);

  // ✅ suit la longueur
  const stepHitRef = useRef(Array(exercise.length).fill(false));

  // refs pour raf loop
  const echoModeRef = useRef(echoMode);
  const echoPhaseRef = useRef(echoPhase);

  // ✅ Mode Écho : bascule après 8 mesures complètes (pas "trop vite")
  const echoListenBars = MIN_BARS; // 8
  const echoPlayBars = MIN_BARS; // 8
  const echoCounterRef = useRef(0);

  // anti-spam parfait
  const perfectCooldownRef = useRef(false);
  const perfectTimerRef = useRef(null);

  useEffect(() => {
    echoModeRef.current = echoMode;
  }, [echoMode]);

  useEffect(() => {
    echoPhaseRef.current = echoPhase;
  }, [echoPhase]);

  const stepMs = useMemo(() => 60000 / bpm / 2, [bpm]);

  function ensureAudio() {
    if (!audioCtxRef.current) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      buffersRef.current.metroAccent = createClickBuffer(ctx, {
        freq: 1900,
        amp: 0.9,
        decay: 90,
      });
      buffersRef.current.metroBeat = createClickBuffer(ctx, {
        freq: 1250,
        amp: 0.6,
        decay: 120,
      });

      buffersRef.current.noteE = createClickBuffer(ctx, { freq: 700, amp: 0.7, decay: 95 });
      buffersRef.current.noteQ = createClickBuffer(ctx, { freq: 480, amp: 0.85, decay: 70 });

      const gMetro = ctx.createGain();
      const gNotes = ctx.createGain();
      gMetro.connect(ctx.destination);
      gNotes.connect(ctx.destination);

      gainsRef.current.metro = gMetro;
      gainsRef.current.notes = gNotes;
    }
    return audioCtxRef.current;
  }

  const effectivePlayNotes = useMemo(() => {
    if (echoMode) return echoPhase === "listen";
    return playNotes;
  }, [echoMode, echoPhase, playNotes]);

  useEffect(() => {
    if (!audioCtxRef.current) return;
    if (gainsRef.current.metro) gainsRef.current.metro.gain.value = volMetro;
    if (gainsRef.current.notes)
      gainsRef.current.notes.gain.value = effectivePlayNotes ? volNotes : 0;
  }, [volMetro, volNotes, effectivePlayNotes]);

  function playBuffer(buffer, gainNode) {
    if (!buffer || !gainNode) return;
    const ctx = ensureAudio();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gainNode);
    src.start();
  }

  function hardResetForExercise(nextExercise) {
    setStepIndex(0);
    setTapHistory([]);
    setStepResult(Array(nextExercise.length).fill(null));
    setExtrasCount(0);
    setShowPerfect(false);

    stepHitRef.current = Array(nextExercise.length).fill(false);
    lastStepRef.current = -1;
    lastStepInBarRef.current = -1;

    // ✅ reset écho bien propre
    echoCounterRef.current = 0;
    if (echoModeRef.current) setEchoPhase("listen");

    perfectCooldownRef.current = false;
    if (perfectTimerRef.current) {
      clearTimeout(perfectTimerRef.current);
      perfectTimerRef.current = null;
    }
  }

  function resetSession({ newExercise = false } = {}) {
    const nextExercise = newExercise ? generateExercise(level, barsCount) : exercise;
    if (newExercise) setExercise(nextExercise);
    hardResetForExercise(nextExercise);
  }

  function startPhase(phase) {
    setEchoPhase(phase);

    setTapHistory([]);
    setStepResult(Array(exercise.length).fill(null));
    setExtrasCount(0);
    setShowPerfect(false);

    stepHitRef.current = Array(exercise.length).fill(false);
    lastStepRef.current = -1;
    lastStepInBarRef.current = -1;

    perfectCooldownRef.current = false;
    if (perfectTimerRef.current) {
      clearTimeout(perfectTimerRef.current);
      perfectTimerRef.current = null;
    }
  }

  function start() {
    const ctx = ensureAudio();
    ctx.resume?.();

    if (gainsRef.current.metro) gainsRef.current.metro.gain.value = volMetro;
    if (gainsRef.current.notes)
      gainsRef.current.notes.gain.value = effectivePlayNotes ? volNotes : 0;

    timerRef.current.startPerfMs = nowMs();
    setIsRunning(true);

    if (echoMode) {
      echoCounterRef.current = 0;
      startPhase("listen");
    }
  }

  function stop() {
    setIsRunning(false);
    if (timerRef.current.raf) cancelAnimationFrame(timerRef.current.raf);
    timerRef.current.raf = null;
  }

  function finalizeStep(prevGlobalStep) {
    if (echoModeRef.current && echoPhaseRef.current !== "play") return;
    if (!attenduMode) return;

    const expected = exercise[prevGlobalStep];
    if (!isOnset(expected)) return;

    const alreadyHit = stepHitRef.current[prevGlobalStep];
    if (!alreadyHit) {
      setStepResult((prev) => {
        const next = [...prev];
        if (next[prevGlobalStep] !== "hit") next[prevGlobalStep] = "miss";
        return next;
      });
    }
  }

  useEffect(() => {
    if (!isRunning) return;

    const loop = () => {
      const elapsedMs = nowMs() - timerRef.current.startPerfMs;
      const globalStep = Math.floor(elapsedMs / stepMs);

      const totalSteps = exercise.length || 1;

      // ✅ step global dans l’exercice (0..totalSteps-1)
      const currentGlobalStep = ((globalStep % totalSteps) + totalSteps) % totalSteps;
      const currentStepInBar = currentGlobalStep % STEPS_PER_BAR;

      // ✅ bascule ÉCOUTE/À TOI seulement après une mesure COMPLÈTE
      // (passage step 7 -> step 0)
      const prevStepInBar = lastStepInBarRef.current;
      if (prevStepInBar === STEPS_PER_BAR - 1 && currentStepInBar === 0) {
        // on vient de finir une mesure complète -> +1 bar
        if (echoModeRef.current) {
          echoCounterRef.current += 1;

          const phase = echoPhaseRef.current;
          const limit = phase === "listen" ? echoListenBars : echoPlayBars;

          if (echoCounterRef.current >= limit) {
            echoCounterRef.current = 0;
            startPhase(phase === "listen" ? "play" : "listen");
          }
        }
      }

      // ✅ step changé
      if (currentGlobalStep !== lastStepRef.current) {
        if (lastStepRef.current >= 0) finalizeStep(lastStepRef.current);

        lastStepRef.current = currentGlobalStep;
        lastStepInBarRef.current = currentStepInBar;
        setStepIndex(currentGlobalStep);

        const isBeat = currentStepInBar % 2 === 0;
        if (isBeat) {
          const beatNumber = currentStepInBar / 2;
          playBuffer(
            beatNumber === 0 ? buffersRef.current.metroAccent : buffersRef.current.metroBeat,
            gainsRef.current.metro
          );
        }

        const expected = exercise[currentGlobalStep];
        const canPlayNotesNow = echoModeRef.current ? echoPhaseRef.current === "listen" : playNotes;

        if (canPlayNotesNow) {
          if (expected === "E") playBuffer(buffersRef.current.noteE, gainsRef.current.notes);
          if (expected === "Q") playBuffer(buffersRef.current.noteQ, gainsRef.current.notes);
        }
      }

      timerRef.current.raf = requestAnimationFrame(loop);
    };

    timerRef.current.raf = requestAnimationFrame(loop);
    return () => {
      if (timerRef.current.raf) cancelAnimationFrame(timerRef.current.raf);
    };
  }, [isRunning, stepMs, attenduMode, exercise, playNotes, echoMode]);

  function triggerPerfect() {
    if (perfectCooldownRef.current) return;

    perfectCooldownRef.current = true;
    setShowPerfect(true);

    if (perfectTimerRef.current) clearTimeout(perfectTimerRef.current);

    perfectTimerRef.current = setTimeout(() => {
      setShowPerfect(false);
      perfectCooldownRef.current = false;
    }, 650);
  }

  function onTap() {
    const t = nowMs();
    const elapsed = t - timerRef.current.startPerfMs;

    const nearestGlobalStep = Math.round(elapsed / stepMs);
    const nearestMs = nearestGlobalStep * stepMs;
    const msError = elapsed - nearestMs;

    const totalSteps = exercise.length || 1;
    const stepGlobal = ((nearestGlobalStep % totalSteps) + totalSteps) % totalSteps;
    const expected = exercise[stepGlobal];

    if (echoModeRef.current && echoPhaseRef.current !== "play") {
      setTapHistory((prev) => [...prev, { msError, when: t, kind: "listen" }].slice(-50));
      return;
    }

    if (!attenduMode) {
      setTapHistory((prev) => [...prev, { msError, when: t, kind: "hit" }].slice(-50));
      return;
    }

    const PERFECT_WINDOW_MS = 45;

    if (isOnset(expected)) {
      stepHitRef.current[stepGlobal] = true;

      setStepResult((prev) => {
        const next = [...prev];
        next[stepGlobal] = "hit";
        return next;
      });

      setTapHistory((prev) => [...prev, { msError, when: t, kind: "hit" }].slice(-50));

      if (Math.abs(msError) <= PERFECT_WINDOW_MS) triggerPerfect();
    } else {
      setExtrasCount((x) => x + 1);
      setTapHistory((prev) => [...prev, { msError, when: t, kind: "extra" }].slice(-50));
    }
  }

  useEffect(() => {
    const handler = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        if (!isRunning) start();
        onTap();
      }
    };
    window.addEventListener("keydown", handler, { passive: false });
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, stepMs, attenduMode, exercise, echoMode]);

  const stats = useMemo(() => {
    if (echoMode && echoPhase !== "play") return { mode: "listen" };

    const onsets = exercise.filter(isOnset).length;
    const hits = stepResult.filter((x) => x === "hit").length;
    const misses = stepResult.filter((x) => x === "miss").length;

    const hitErrors = tapHistory.filter((t) => t.kind === "hit").map((t) => t.msError);
    const abs = hitErrors.map((e) => Math.abs(e));
    const meanAbs = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null;

    let score = 0;

    if (!attenduMode) {
      if (meanAbs == null) return null;
      score = Math.round(100 * (1 - clamp(meanAbs / 150, 0, 1)));
      return { mode: "libre", score, meanAbs, taps: tapHistory.length };
    }

    const lectureAcc = onsets ? hits / onsets : 0;
    const timingBonus = meanAbs == null ? 0.6 : clamp(1 - meanAbs / 120, 0, 1);
    const penalty = clamp(misses * 0.15 + extrasCount * 0.1, 0, 0.9);

    score = Math.round(100 * clamp(lectureAcc * 0.7 + timingBonus * 0.3 - penalty, 0, 1));
    return { mode: "attendu", score, onsets, hits, misses, extras: extrasCount, meanAbs };
  }, [attenduMode, exercise, stepResult, extrasCount, tapHistory, echoMode, echoPhase]);

  useEffect(() => {
    if (!stats || stats.mode !== "attendu") return;
    if (!isRunning) return;

    if (typeof stats.score === "number" && stats.score >= 90) {
      setShowConfetti(true);
      const t = setTimeout(() => setShowConfetti(false), 900);
      return () => clearTimeout(t);
    }
  }, [stats, isRunning]);

  const expectedAtStep = exercise[stepIndex];

  const phaseLabel = useMemo(() => {
    if (!echoMode) return null;
    return echoPhase === "listen" ? "ÉCOUTE" : "À TOI";
  }, [echoMode, echoPhase]);

  const phaseHint = useMemo(() => {
    if (!echoMode) return null;
    return echoPhase === "listen"
      ? "Démo : écoute (les notes sont jouées)"
      : "À toi : joue (les notes sont coupées)";
  }, [echoMode, echoPhase]);

  return (
    <div className="wrap">
      <Confetti show={showConfetti} />

      <header className="header">
        <div className="title">
          <h1>Solfège rythmique (batterie)</h1>
          <p>
            Métronome + <b>lecture audio des notes</b> + entraînement au <b>tap</b>.
          </p>
        </div>

        {echoMode && (
          <div className={`phaseBadge ${echoPhase === "listen" ? "listen" : "play"}`}>
            {phaseLabel} <span className="phaseSub">— {phaseHint}</span>
          </div>
        )}
      </header>

      <div className="grid">
        <section className="card">
          <h2>Réglages</h2>

          <div className="row">
            <label>BPM</label>
            <input
              type="range"
              min="40"
              max="220"
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
            <div className="pill">{bpm}</div>
          </div>

          {/* ✅ Mesures 8 → 16 */}
          <div className="row">
            <label>Mesures</label>
            <input
              type="range"
              min={MIN_BARS}
              max={MAX_BARS}
              value={barsCount}
              onChange={(e) => {
                const v = Number(e.target.value);
                setBarsCount(v);
                const next = generateExercise(level, v);
                setExercise(next);
                hardResetForExercise(next);
              }}
            />
            <div className="pill">{barsCount}</div>
          </div>

          <div className="row">
            <label>Niveau</label>
            <select
              value={level}
              onChange={(e) => {
                const lv = Number(e.target.value);
                setLevel(lv);
              }}
            >
              <option value={1}>1 — Noires + silences</option>
              <option value={2}>2 — Croches + silences</option>
              <option value={3}>3 — Mix noires/croches</option>
            </select>

            <button className="btn" onClick={() => resetSession({ newExercise: true })}>
              🎼 Nouvel exercice
            </button>
          </div>

          <div className="row">
            <label>Écho</label>
            <label className="toggle">
              <input
                checked={echoMode}
                type="checkbox"
                onChange={(e) => {
                  const next = e.target.checked;
                  setEchoMode(next);
                  resetSession({ newExercise: false });
                  if (next) setEchoPhase("listen");
                }}
              />
              <span>Mode Écho</span>
            </label>
            <div className="pill">{echoMode ? "ON" : "OFF"}</div>
          </div>

          <div className="row">
            <label>Notes</label>
            <label className="toggle">
              <input
                checked={playNotes}
                type="checkbox"
                onChange={(e) => setPlayNotes(e.target.checked)}
                disabled={echoMode}
              />
              <span>Jouer les notes</span>
            </label>
            <div className="pill">{echoMode ? "AUTO" : playNotes ? "ON" : "OFF"}</div>
          </div>

          <div className="row">
            <label>Vol. clic</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volMetro}
              onChange={(e) => setVolMetro(Number(e.target.value))}
            />
            <div className="pill">{Math.round(volMetro * 100)}%</div>
          </div>

          <div className="row">
            <label>Vol. notes</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volNotes}
              onChange={(e) => setVolNotes(Number(e.target.value))}
            />
            <div className="pill">{Math.round(volNotes * 100)}%</div>
          </div>

          <div className="row">
            <label>Mode</label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={attenduMode}
                onChange={(e) => {
                  setAttenduMode(e.target.checked);
                  resetSession({ newExercise: false });
                }}
              />
              <span>Attendu</span>
            </label>
            <div className="pill">{attenduMode ? "Lecture" : "Libre"}</div>
          </div>

          <div className="row sessionRow">
            <label>Session</label>
            <div className="sessionActions">
              {!isRunning ? (
                <button className="btn primary" onClick={start}>
                  ▶ Démarrer l’exercice
                </button>
              ) : (
                <button className="btn danger" onClick={stop}>
                  ■ Arrêter
                </button>
              )}

              <button className="btn" onClick={() => resetSession({ newExercise: false })}>
                🔄 Recommencer
              </button>
            </div>
          </div>

          <div className="hint">
            {echoMode ? (
              <>
                Mode Écho : <b>ÉCOUTE</b> (notes jouées) ➜ <b>À TOI</b> (notes coupées). Démo puis
                imitation.
              </>
            ) : (
              <>
                Tu as <b>le clic</b> + <b>les notes</b> : ♪ (croche) et ♩ (noire) ont un son
                différent. Silences/liaisons = aucun son.
              </>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Exercice ({barsCount} mesures en 4/4)</h2>

          <div className="barWrap">
            <div className={`perfectBanner ${showPerfect ? "show" : ""}`}>{bannerText}</div>

            <div className="bar">
              {exercise.map((s, i) => {
                const isActive = i === stepIndex && isRunning;

                // ✅ beat local (dans la mesure)
                const stepInBar = i % STEPS_PER_BAR;
                const isBeat = stepInBar % 2 === 0;

                // séparation de mesure + fond alterné (si CSS)
                const isBarStart = stepInBar === 0;
                const barIndex = Math.floor(i / STEPS_PER_BAR);
                const isAltBar = barIndex % 2 === 1;

                const res = stepResult[i];

                return (
                  <div
                    key={i}
                    className={[
                      "cell",
                      isBeat ? "beat" : "",
                      isBarStart ? "barStart" : "",
                      isBarStart && isAltBar ? "altBar" : "",
                      isActive ? "active" : "",
                      s === "R" ? "rest" : "",
                      res === "hit" ? "hit" : "",
                      res === "miss" ? "miss" : "",
                    ].join(" ")}
                  >
                    <div className="small">{isBeat ? stepInBar / 2 + 1 : ""}</div>
                    <div className="glyph">{formatStep(s)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="legend">
            <span>
              <b>♩</b> = noire (2 cases)
            </span>
            <span>
              <b>♪</b> = croche (1 case)
            </span>
            <span>
              <b>𝄽</b> = silence
            </span>
            <span>
              <b>vide</b> = liaison
            </span>
          </div>

          <div className="current">
            Step: <b>{stepIndex + 1}</b> / {exercise.length} — attendu :{" "}
            <b>{expectedAtStep ? formatStep(expectedAtStep) : "—"}</b>
          </div>
        </section>

        <section className="card">
          <h2>Tap</h2>

          {echoMode && (
            <div className={`phaseBadge ${echoPhase === "listen" ? "listen" : "play"}`}>
              {phaseLabel} <span className="phaseSub">— {phaseHint}</span>
            </div>
          )}

          <button
            className="btn primary big"
            onClick={() => {
              if (!isRunning) start();
              onTap();
            }}
          >
            TAP (ou Espace)
          </button>

          <div className="stats">
            {stats ? (
              stats.mode === "listen" ? (
                <div className="muted">Écoute la démo… (on ne note pas pendant “ÉCOUTE”).</div>
              ) : stats.mode === "attendu" ? (
                <>
                  <div className="pill">Score: {stats.score}/100</div>
                  <div className="pill">
                    Notes: {stats.hits}/{stats.onsets}
                  </div>
                  <div className="pill">Miss: {stats.misses}</div>
                  <div className="pill">Extra: {stats.extras}</div>
                  <div className="pill">
                    Moy.: {stats.meanAbs == null ? "—" : `${stats.meanAbs.toFixed(1)} ms`}
                  </div>
                </>
              ) : (
                <>
                  <div className="pill">Score: {stats.score}/100</div>
                  <div className="pill">Moy.: {stats.meanAbs.toFixed(1)} ms</div>
                  <div className="pill">Taps: {stats.taps}</div>
                </>
              )
            ) : (
              <div className="muted">Tape en rythme pour voir ton score.</div>
            )}
          </div>

          <div className="hint">
            Conseil : mets <b>Vol. notes</b> plus fort que <b>Vol. clic</b> au début. Après, on
            inverse quand l’élève devient autonome 😄
          </div>
        </section>
      </div>

      <footer className="footer">© {new Date().getFullYear()} — Alex Ouemba</footer>
    </div>
  );
}