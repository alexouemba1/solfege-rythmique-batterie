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
  Q: "♩", // noire (attaque sur 1 step, dure 2 steps)
  E: "♪", // croche (attaque sur 1 step)
  R: "𝄽", // silence
};

const STEPS_PER_BAR = 8;

function isOnset(step) {
  return step === "E" || step === "Q";
}

function generateExercise(level = 1) {
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

export default function App() {
  const [bpm, setBpm] = useState(90);
  const [level, setLevel] = useState(1);
  const [isRunning, setIsRunning] = useState(false);
  const [attenduMode, setAttenduMode] = useState(true);

  // ✅ activer/désactiver "lecture des notes"
  const [playNotes, setPlayNotes] = useState(true);

  // ✅ volumes séparés
  const [volMetro, setVolMetro] = useState(0.8);
  const [volNotes, setVolNotes] = useState(0.6);

  const [exercise, setExercise] = useState(() => generateExercise(1));
  const [stepIndex, setStepIndex] = useState(0);

  const [tapHistory, setTapHistory] = useState([]);
  const [stepResult, setStepResult] = useState(() => Array(STEPS_PER_BAR).fill(null));
  const [extrasCount, setExtrasCount] = useState(0);

  const audioCtxRef = useRef(null);

  // buffers + gains
  const buffersRef = useRef({
    metroAccent: null,
    metroBeat: null,
    noteE: null, // croche
    noteQ: null, // noire
  });

  const gainsRef = useRef({
    metro: null,
    notes: null,
  });

  const timerRef = useRef({ raf: null, startPerfMs: 0 });
  const lastStepRef = useRef(-1);
  const stepHitRef = useRef(Array(STEPS_PER_BAR).fill(false));
  const lastBarIndexRef = useRef(0);

  const stepMs = useMemo(() => 60000 / bpm / 2, [bpm]);

  function ensureAudio() {
    if (!audioCtxRef.current) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;

      // Métronome (aigu)
      buffersRef.current.metroAccent = createClickBuffer(ctx, { freq: 1900, amp: 0.9, decay: 90 });
      buffersRef.current.metroBeat = createClickBuffer(ctx, { freq: 1250, amp: 0.6, decay: 120 });

      // Notes (timbres distincts)
      buffersRef.current.noteE = createClickBuffer(ctx, { freq: 700, amp: 0.7, decay: 95 });
      buffersRef.current.noteQ = createClickBuffer(ctx, { freq: 480, amp: 0.85, decay: 70 });

      // Gains séparés
      const gMetro = ctx.createGain();
      const gNotes = ctx.createGain();
      gMetro.connect(ctx.destination);
      gNotes.connect(ctx.destination);

      gainsRef.current.metro = gMetro;
      gainsRef.current.notes = gNotes;
    }
    return audioCtxRef.current;
  }

  // met à jour les volumes
  useEffect(() => {
    if (!audioCtxRef.current) return;
    if (gainsRef.current.metro) gainsRef.current.metro.gain.value = volMetro;
    if (gainsRef.current.notes) gainsRef.current.notes.gain.value = playNotes ? volNotes : 0;
  }, [volMetro, volNotes, playNotes]);

  function playBuffer(buffer, gainNode) {
    if (!buffer || !gainNode) return;
    const ctx = ensureAudio();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gainNode);
    src.start();
  }

  function resetSession({ newExercise = false } = {}) {
    setStepIndex(0);
    setTapHistory([]);
    setStepResult(Array(STEPS_PER_BAR).fill(null));
    setExtrasCount(0);

    stepHitRef.current = Array(STEPS_PER_BAR).fill(false);
    lastStepRef.current = -1;
    lastBarIndexRef.current = 0;

    if (newExercise) setExercise(generateExercise(level));
  }

  function start() {
    const ctx = ensureAudio();
    ctx.resume?.();
    if (gainsRef.current.metro) gainsRef.current.metro.gain.value = volMetro;
    if (gainsRef.current.notes) gainsRef.current.notes.gain.value = playNotes ? volNotes : 0;

    timerRef.current.startPerfMs = nowMs();
    setIsRunning(true);
  }

  function stop() {
    setIsRunning(false);
    if (timerRef.current.raf) cancelAnimationFrame(timerRef.current.raf);
    timerRef.current.raf = null;
  }

  function finalizeStep(prevStep) {
    if (!attenduMode) return;
    const expected = exercise[prevStep];
    if (!isOnset(expected)) return;

    const alreadyHit = stepHitRef.current[prevStep];
    if (!alreadyHit) {
      setStepResult((prev) => {
        const next = [...prev];
        if (next[prevStep] !== "hit") next[prevStep] = "miss";
        return next;
      });
    }
  }

  // Scheduler: métronome + lecture des notes
  useEffect(() => {
    if (!isRunning) return;

    const loop = () => {
      const elapsedMs = nowMs() - timerRef.current.startPerfMs;
      const globalStep = Math.floor(elapsedMs / stepMs);
      const currentBarIndex = Math.floor(globalStep / STEPS_PER_BAR);
      const currentStep = globalStep % STEPS_PER_BAR;

      if (currentBarIndex !== lastBarIndexRef.current) {
        finalizeStep(STEPS_PER_BAR - 1);
        lastBarIndexRef.current = currentBarIndex;
      }

      if (currentStep !== lastStepRef.current) {
        if (lastStepRef.current >= 0) finalizeStep(lastStepRef.current);

        lastStepRef.current = currentStep;
        setStepIndex(currentStep);

        // 1) Métronome sur les temps (0,2,4,6) accent sur 0
        const isBeat = currentStep % 2 === 0;
        if (isBeat) {
          const beatNumber = currentStep / 2;
          playBuffer(
            beatNumber === 0 ? buffersRef.current.metroAccent : buffersRef.current.metroBeat,
            gainsRef.current.metro
          );
        }

        // 2) Lecture des notes: joue UNIQUEMENT si attaque (E ou Q)
        if (playNotes) {
          const expected = exercise[currentStep];
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
  }, [isRunning, stepMs, attenduMode, exercise, playNotes]);

  function onTap() {
    const t = nowMs();
    const elapsed = t - timerRef.current.startPerfMs;

    const nearestGlobalStep = Math.round(elapsed / stepMs);
    const nearestMs = nearestGlobalStep * stepMs;
    const msError = elapsed - nearestMs;

    const stepInBar = ((nearestGlobalStep % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
    const expected = exercise[stepInBar];

    if (!attenduMode) {
      setTapHistory((prev) => [...prev, { msError, when: t, kind: "hit" }].slice(-50));
      return;
    }

    if (isOnset(expected)) {
      stepHitRef.current[stepInBar] = true;
      setStepResult((prev) => {
        const next = [...prev];
        next[stepInBar] = "hit";
        return next;
      });
      setTapHistory((prev) => [...prev, { msError, when: t, kind: "hit" }].slice(-50));
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
  }, [isRunning, stepMs, attenduMode, exercise]);

  const stats = useMemo(() => {
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
  }, [attenduMode, exercise, stepResult, extrasCount, tapHistory]);

  const expectedAtStep = exercise[stepIndex];

  return (
    <div className="wrap">
      <header className="header">
        <div className="title">
          <h1>Solfège rythmique (batterie)</h1>
          <p>
            Métronome + <b>lecture audio des notes</b> + entraînement au <b>tap</b>.
          </p>
        </div>
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

          <div className="row">
            <label>Niveau</label>
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              <option value={1}>1 — Noires + silences</option>
              <option value={2}>2 — Croches + silences</option>
              <option value={3}>3 — Mix noires/croches</option>
            </select>

            <button className="btn" onClick={() => resetSession({ newExercise: true })}>
              🎼 Nouvel exercice
            </button>
          </div>

          <div className="row">
            <label>Notes</label>
            <label className="toggle">
              <input
                checked={playNotes}
                type="checkbox"
                onChange={(e) => setPlayNotes(e.target.checked)}
              />
              <span>Jouer les notes</span>
            </label>
            <div className="pill">{playNotes ? "ON" : "OFF"}</div>
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

          {/* ✅ LIGNE SESSION corrigée */}
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
            Là tu as bien <b>le clic</b> + <b>les notes</b> : ♪ (croche) et ♩ (noire) ont un son
            différent. Silences/liaisons = aucun son.
          </div>
        </section>

        <section className="card">
          <h2>Exercice (1 mesure en 4/4)</h2>

          <div className="bar">
            {exercise.map((s, i) => {
              const isActive = i === stepIndex && isRunning;
              const isBeat = i % 2 === 0;
              const res = stepResult[i];

              return (
                <div
                  key={i}
                  className={[
                    "cell",
                    isBeat ? "beat" : "",
                    isActive ? "active" : "",
                    s === "R" ? "rest" : "",
                    res === "hit" ? "hit" : "",
                    res === "miss" ? "miss" : "",
                  ].join(" ")}
                >
                  <div className="small">{isBeat ? i / 2 + 1 : ""}</div>
                  <div className="glyph">{formatStep(s)}</div>
                </div>
              );
            })}
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
            Step: <b>{stepIndex + 1}</b> / {STEPS_PER_BAR} — attendu :{" "}
            <b>{expectedAtStep ? formatStep(expectedAtStep) : "—"}</b>
          </div>
        </section>

        <section className="card">
          <h2>Tap</h2>

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
              stats.mode === "attendu" ? (
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

      {/* ✅ SIGNATURE */}
      <footer className="footer">© {new Date().getFullYear()} — Alex Ouemba</footer>
    </div>
  );
}