'use strict';

/*
 * Decorative layer for the login / register / dashboard pages.
 * Purely visual: it never touches forms, fetch calls or session logic
 * (those stay in auth.js / dashboard.js). Every layer it adds is
 * pointer-events:none, and the whole thing can be switched off with the
 * "Calm mode" button (remembered in localStorage) or prefers-reduced-motion.
 */
(() => {
  const KEY = 'agt-calm';
  const root = document.documentElement;

  // Apply calm mode before first paint (this file is loaded in <head>).
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  const prefersReduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (saved === '1' || (saved === null && prefersReduce)) root.classList.add('calm');
  const isCalm = () => root.classList.contains('calm');

  /* ---------------- background canvas: packets on the grid + price line ---------------- */
  function createFloor() {
    let cv;
    let ctx;
    try {
      cv = document.createElement('canvas');
      cv.className = 'fx-canvas';
      cv.setAttribute('aria-hidden', 'true');
      ctx = cv.getContext('2d');
    } catch { return null; }
    if (!ctx) return null;
    document.body.prepend(cv);

    const G = 112;                       // major grid spacing (matches style.css)
    const STEP = 16;
    let W = 0; let H = 0; let packets = []; let blips = []; let line = [];
    let scroll = 0; let raf = 0; let last = 0; let blipT = 0; let cost = 0; let budget = 1;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const labels = ['BUY', 'SELL', '+2.41%', 'FILL', 'BID ↑', 'ASK ↓', '+1.08%', 'SYNC', 'AUTH ✓'];

    const packet = () => {
      const hz = Math.random() < 0.6;
      const lanes = hz ? Math.ceil(H / G) : Math.ceil(W / G);
      const dir = Math.random() < 0.5 ? 1 : -1;
      return {
        hz, dir,
        lane: Math.floor(rnd(1, Math.max(2, lanes))) * G,
        pos: dir > 0 ? -60 : (hz ? W : H) + 60,
        v: rnd(1.4, 3), len: rnd(40, 90), green: Math.random() < 0.3,
      };
    };
    const next = (v) => Math.max(H * 0.62, Math.min(H * 0.92, v + (Math.random() - 0.47) * 18));

    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, innerWidth < 700 ? 1.25 : 1.5);
      W = innerWidth; H = innerHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      packets = Array.from({ length: W < 700 ? 8 : 16 }, () => {
        const p = packet(); p.pos = rnd(0, p.hz ? W : H); return p;
      });
      line = [H * 0.8];
      while (line.length * STEP < W + STEP * 3) line.push(next(line[line.length - 1]));
      blips = [];
    }

    function draw(now) {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return;                       // ~30 fps is plenty for ambience
      const dt = Math.min(3, (now - last) / 16.7 || 1);
      last = now;
      const t0 = performance.now();
      try {
        ctx.clearRect(0, 0, W, H);
        // scrolling price line with soft fill
        scroll += 0.5 * dt;
        while (scroll >= STEP) { scroll -= STEP; line.shift(); line.push(next(line[line.length - 1])); }
        const off = scroll % STEP;
        const path = () => {
          ctx.beginPath();
          line.forEach((y, i) => { const x = i * STEP - off; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        };
        path();
        ctx.lineTo((line.length - 1) * STEP - off, H); ctx.lineTo(-off, H); ctx.closePath();
        const fill = ctx.createLinearGradient(0, H * 0.55, 0, H);
        fill.addColorStop(0, 'rgba(242,193,78,.11)'); fill.addColorStop(1, 'rgba(242,193,78,0)');
        ctx.fillStyle = fill; ctx.fill();
        path();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(242,193,78,.13)'; ctx.lineWidth = 6; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,215,120,.6)'; ctx.lineWidth = 1.4; ctx.stroke();

        // data packets travelling along grid lines
        const n = Math.max(4, Math.round(packets.length * budget));
        for (let i = 0; i < n; i++) {
          const p = packets[i];
          p.pos += p.v * p.dir * dt;
          if (p.pos < -120 || p.pos > (p.hz ? W : H) + 120) { packets[i] = packet(); continue; }
          const hx = p.hz ? p.pos : p.lane; const hy = p.hz ? p.lane : p.pos;
          const tx = p.hz ? p.pos - p.len * p.dir : p.lane; const ty = p.hz ? p.lane : p.pos - p.len * p.dir;
          const col = p.green ? '51,209,122' : '255,214,120';
          const g = ctx.createLinearGradient(tx, ty, hx, hy);
          g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(1, `rgba(${col},.75)`);
          ctx.strokeStyle = g; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
          ctx.fillStyle = `rgba(${col},.95)`; ctx.beginPath(); ctx.arc(hx, hy, 1.9, 0, 6.3); ctx.fill();
        }

        // blips at grid intersections
        blipT -= dt;
        if (blipT <= 0 && blips.length < 4) {
          blipT = rnd(20, 44);
          blips.push({
            x: Math.round(rnd(1, W / G - 1)) * G, y: Math.round(rnd(1, H / G - 1)) * G,
            a: 0, lb: labels[Math.floor(Math.random() * labels.length)], up: Math.random() < 0.6,
          });
        }
        ctx.font = '600 10px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'middle';
        blips = blips.filter((b) => {
          b.a += 0.012 * dt;
          if (b.a >= 1) return false;
          const col = b.up ? '51,209,122' : '255,190,90'; const fade = 1 - b.a;
          ctx.strokeStyle = `rgba(${col},${fade * 0.7})`; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(b.x, b.y, 4 + b.a * 30, 0, 6.3); ctx.stroke();
          ctx.fillStyle = `rgba(${col},${fade})`; ctx.fillRect(b.x - 2, b.y - 2, 4, 4);
          ctx.fillStyle = `rgba(${col},${Math.min(1, fade * 1.4) * 0.8})`; ctx.fillText(b.lb, b.x + 12, b.y - 12);
          return true;
        });
      } catch {
        api.stop(true);
        return;
      }
      cost = cost * 0.9 + (performance.now() - t0) * 0.1;   // slow device → fewer packets
      if (cost > 9) budget = Math.max(0.35, budget - 0.05); else if (cost < 4) budget = Math.min(1, budget + 0.02);
    }

    const api = {
      start() {
        if (raf || isCalm() || document.hidden) return;
        cv.style.display = '';
        last = 0; raf = requestAnimationFrame(draw);
      },
      stop(clear) {
        cancelAnimationFrame(raf); raf = 0;
        if (clear) { try { ctx.clearRect(0, 0, W, H); } catch { /* ignore */ } cv.style.display = 'none'; }
      },
    };
    let rt;
    try { size(); } catch { cv.remove(); return null; }
    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { try { size(); } catch { /* ignore */ } }, 150); };
    const onVis = () => (document.hidden ? api.stop(false) : api.start());
    addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    addEventListener('pagehide', () => {
      api.stop(true);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    });
    return api;
  }

  /* ---------------- soft pulse when a value is filled in or changes ---------------- */
  function flash(el) {
    if (!el || isCalm()) return;
    const nextCls = el.dataset.fl === 'fu1' ? 'fu2' : 'fu1';
    if (el.dataset.fl) el.classList.remove(el.dataset.fl);
    el.classList.add(nextCls); el.dataset.fl = nextCls;
  }

  function init() {
    const body = document.body;
    if (!body) return;

    const scan = document.createElement('div'); scan.className = 'fx-scan'; scan.setAttribute('aria-hidden', 'true');
    const edge = document.createElement('div'); edge.className = 'fx-edge'; edge.setAttribute('aria-hidden', 'true');
    body.prepend(scan); body.append(edge);
    const floor = createFloor();

    // Calm-mode toggle
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'calm-toggle';
    const dot = document.createElement('span'); dot.className = 'dot';
    const label = document.createElement('span');
    btn.append(dot, label);
    const sync = () => {
      const calm = isCalm();
      btn.setAttribute('aria-pressed', String(calm));
      label.textContent = calm ? 'โหมดนิ่ง: เปิด' : 'เอฟเฟกต์: เปิด';
      btn.title = calm ? 'กดเพื่อเปิดเอฟเฟกต์เคลื่อนไหว' : 'โหมดนิ่ง / ลดเอฟเฟกต์';
      if (floor) { if (calm) floor.stop(true); else floor.start(); }
    };
    btn.addEventListener('click', () => {
      root.classList.toggle('calm');
      try { localStorage.setItem(KEY, isCalm() ? '1' : '0'); } catch { /* storage blocked */ }
      sync();
    });
    body.append(btn);
    sync();

    // Pulse dashboard values when dashboard.js fills them in (observe only, no logic change)
    ['username', 'email', 'created'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el || !window.MutationObserver) return;
      const obs = new MutationObserver(() => flash(el.tagName === 'DD' ? el : el.parentElement));
      obs.observe(el, { childList: true, characterData: true, subtree: true });
      addEventListener('pagehide', () => obs.disconnect());
    });

    // Red edge flash when an error appears (form or dashboard)
    document.querySelectorAll('.error').forEach((box) => {
      if (!window.MutationObserver) return;
      const obs = new MutationObserver(() => {
        if (box.hidden || isCalm()) return;
        edge.classList.remove('alarm'); void edge.offsetWidth; edge.classList.add('alarm');
      });
      obs.observe(box, { attributes: true, attributeFilter: ['hidden'] });
      addEventListener('pagehide', () => obs.disconnect());
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
