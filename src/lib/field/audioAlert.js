/**
 * Multimodal field confirmation: vibration + WebAudio tone with master-gain
 * ducking (radio squelch cadence) so confirmations cut through sirens without
 * stomping on TX audio.
 */

let audioCtx = null;
let masterGain = null;
let duckTimer = null;

function ctx() {
  if (audioCtx) return audioCtx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  audioCtx = new AC();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(audioCtx.destination);
  return audioCtx;
}

export function vibrate(pattern) {
  try {
    if (
      globalThis.navigator &&
      typeof globalThis.navigator.vibrate === "function"
    ) {
      return globalThis.navigator.vibrate(pattern);
    }
  } catch {
    // best-effort — surface failures are non-fatal here
  }
  return false;
}

/**
 * Play a short confirmation tone.
 * @param {{frequency?:number, durationMs?:number, gain?:number}} opts
 */
export function playTone({
  frequency = 880,
  durationMs = 180,
  gain = 0.45,
} = {}) {
  const ac = ctx();
  if (!ac) return false;
  try {
    if (ac.state === "suspended") ac.resume();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "square";
    osc.frequency.value = frequency;
    g.gain.value = 0;
    osc.connect(g);
    g.connect(masterGain);
    const t0 = ac.currentTime;
    g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
    g.gain.setValueAtTime(gain, t0 + durationMs / 1000 - 0.04);
    g.gain.linearRampToValueAtTime(0.0001, t0 + durationMs / 1000);
    osc.start(t0);
    osc.stop(t0 + durationMs / 1000 + 0.02);
    return true;
  } catch {
    return false;
  }
}

/** Duck master gain to `level` for `ms` — call when the radio is transmitting. */
export function duck(ms = 600, level = 0.25) {
  const ac = ctx();
  if (!ac || !masterGain) return;
  try {
    if (duckTimer) clearTimeout(duckTimer);
    masterGain.gain.setTargetAtTime(level, ac.currentTime, 0.03);
    duckTimer = setTimeout(() => {
      try {
        masterGain.gain.setTargetAtTime(1, ac.currentTime, 0.08);
      } catch {
        // best-effort — surface failures are non-fatal here
      }
      duckTimer = null;
    }, ms);
  } catch {
    // best-effort — surface failures are non-fatal here
  }
}

/** Loud multimodal confirmation for gloved/noisy conditions. */
export function fieldConfirm({
  haptic = true,
  tone = true,
  loud = false,
} = {}) {
  if (haptic) vibrate([200, 100, 200]);
  if (tone) {
    playTone({
      frequency: loud ? 1200 : 880,
      durationMs: loud ? 260 : 160,
      gain: loud ? 0.7 : 0.4,
    });
  }
}

export const SOS_TONE = { frequency: 1400, durationMs: 400, gain: 0.8 };

export function sosAlert() {
  vibrate([300, 120, 300, 120, 300]);
  playTone(SOS_TONE);
}
