// Small shared helpers for the web UI.

/** Short completion beep via WebAudio (no asset files needed). */
export function beep(freq = 880) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => ctx.close(), 700);
  } catch { /* audio blocked */ }
}

/** Fire a browser notification if permitted (no permission prompt here). */
export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted")
      new Notification(title, { body });
  } catch { /* blocked */ }
}
