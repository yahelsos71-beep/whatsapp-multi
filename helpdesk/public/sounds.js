// צלצולים – נוצרים בקוד, בלי קבצים. הגדרות נשמרות לכל משתמש בדפדפן.
const Sounds = (() => {
  let ctx = null;
  const TONES = {
    double: { name: 'צפצוף כפול', notes: [[880, 0, 0.18], [1320, 0.15, 0.25]] },
    soft: { name: 'דינג רך', notes: [[660, 0, 0.6], [990, 0, 0.4]] },
    bell: { name: 'פעמון', notes: [[1046, 0, 1.4, 'triangle'], [2093, 0, 0.9], [3136, 0, 0.5]] },
    marimba: { name: 'מרימבה', notes: [[523, 0, 0.3, 'triangle'], [659, 0.13, 0.3, 'triangle'], [784, 0.26, 0.5, 'triangle']] },
    chime: { name: 'צלצול דלת', notes: [[988, 0, 0.7, 'triangle'], [784, 0.35, 1.0, 'triangle']] },
    phone: { name: 'טלפון קלאסי', notes: [...Array(16)].map((_, i) => [i % 2 ? 1700 : 1300, i * 0.05 + (i >= 8 ? 0.25 : 0), 0.05, 'square']) },
    alarm: { name: 'אזעקה', notes: [[600, 0, 0.45, 'sawtooth', 1400], [600, 0.5, 0.45, 'sawtooth', 1400]] },
    beep3: { name: '3 צפצופים חזקים', notes: [[1000, 0, 0.18], [800, 0.2, 0.2], [1000, 0.45, 0.18], [800, 0.65, 0.2], [1000, 0.9, 0.18], [800, 1.1, 0.2]] },
  };
  const DEF = { newTone: 'double', remindTone: 'phone', remindSec: 30, vol: 0.8, muted: false };
  let settings = { ...DEF };
  try { settings = { ...DEF, ...JSON.parse(localStorage.getItem('hd-sounds') || '{}') }; } catch {}
  const save = () => { try { localStorage.setItem('hd-sounds', JSON.stringify(settings)); } catch {} };

  function unlock() {
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {}
  }
  function play(key) {
    unlock();
    if (!ctx) return;
    const v = settings.vol;
    for (const [f, start, dur, type = 'sine', f2] of (TONES[key] || TONES.double).notes) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const t0 = ctx.currentTime + start;
      o.type = type;
      o.frequency.setValueAtTime(f, t0);
      if (f2) o.frequency.linearRampToValueAtTime(f2, t0 + dur);
      const peak = type === 'square' || type === 'sawtooth' ? v * 0.35 : v;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
  }
  document.addEventListener('click', unlock, { capture: true });
  document.addEventListener('keydown', unlock, { capture: true });
  return {
    TONES, settings, save,
    newMessage: () => { if (!settings.muted) play(settings.newTone); },
    reminder: () => { if (!settings.muted) play(settings.remindTone); },
    play,
    unlocked: () => !!ctx && ctx.state === 'running',
  };
})();
