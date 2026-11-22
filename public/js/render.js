(function (global) {
  'use strict';

  function worldToScreen(x, y, cam, view) {
    return [
      view.w / 2 + (x - cam.x) * cam.zoom,
      view.h / 2 + (y - cam.y) * cam.zoom
    ];
  }

  function createRenderer(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let dpr = 1;

    function resize() {
      const next = Math.min(global.devicePixelRatio || 1, 2);
      const w = global.innerWidth;
      const h = global.innerHeight;
      const pw = Math.max(1, Math.round(w * next));
      const ph = Math.max(1, Math.round(h * next));
      if (canvas.width !== pw || canvas.height !== ph || next !== dpr) {
        dpr = next;
        canvas.width = pw;
        canvas.height = ph;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      return { w, h };
    }

    function draw(scene, view) {
      const cam = scene.cam;
      const w = view.w;
      const h = view.h;
      ctx.fillStyle = '#07141c';
      ctx.fillRect(0, 0, w, h);
      drawGrid(cam, view);
      drawFoods(scene, cam, view);
      for (const snake of scene.snakes) drawSnake(snake, cam, view);
      if (scene.beacon) drawBeacon(scene, cam, view);
      drawParticles(scene, cam, view);
      drawOutside(scene, cam, view);
      drawBorder(scene, cam, view);
      drawDanger(scene, cam, view);
      drawMinimap(scene, view);
    }

    function drawGrid(cam, view) {
      const zoom = cam.zoom || 1;
      const left = cam.x - view.w / 2 / zoom;
      const right = cam.x + view.w / 2 / zoom;
      const top = cam.y - view.h / 2 / zoom;
      const bottom = cam.y + view.h / 2 / zoom;
      const step = 96;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(120, 190, 170, 0.09)';
      ctx.lineWidth = 1;
      for (let x = Math.floor(left / step) * step; x <= right; x += step) {
        const sx = worldToScreen(x, 0, cam, view)[0];
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, view.h);
      }
      for (let y = Math.floor(top / step) * step; y <= bottom; y += step) {
        const sy = worldToScreen(0, y, cam, view)[1];
        ctx.moveTo(0, sy);
        ctx.lineTo(view.w, sy);
      }
      ctx.stroke();
    }

    function drawFoods(scene, cam, view) {
      const palette = scene.foodPalette || ['#ffd60a'];
      for (const food of scene.foods) {
        const [sx, sy] = worldToScreen(food.x, food.y, cam, view);
        if (sx < -30 || sy < -30 || sx > view.w + 30 || sy > view.h + 30) continue;
        const color = palette[food.color % palette.length] || '#ffd60a';
        const radius = Math.max(3.4, Math.min(15, 3.2 + food.value * 1.15)) * cam.zoom;
        if (food.kind === 'gold') {
          const pulse = radius + 6 + Math.sin(scene.time / 160) * 2;
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(255, 214, 10, 0.85)';
          ctx.lineWidth = 2;
          ctx.arc(sx, sy, pulse, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.arc(sx - radius * 0.25, sy - radius * 0.28, Math.max(1, radius * 0.28), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawSnake(snake, cam, view) {
      const pts = snake.points && snake.points.length ? snake.points : [[snake.x, snake.y]];
      if (!isNear(pts, cam, view, 80)) return;
      const headR = (10 + Math.min(8, (snake.mass || 10) * 0.03)) * cam.zoom;
      ctx.save();
      ctx.globalAlpha = snake.connected === false ? 0.42 : 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [sx, sy] = worldToScreen(pts[i][0], pts[i][1], cam, view);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = headR * 2.15;
      ctx.stroke();
      ctx.strokeStyle = snake.color || '#3ee0b0';
      ctx.lineWidth = headR * 1.7;
      ctx.stroke();

      const [hx, hy] = worldToScreen(snake.x, snake.y, cam, view);
      ctx.beginPath();
      ctx.fillStyle = '#f7fff9';
      ctx.arc(hx, hy, headR * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = snake.color || '#3ee0b0';
      ctx.arc(hx, hy, headR * 0.56, 0, Math.PI * 2);
      ctx.fill();
      drawEyes(snake, hx, hy, headR, cam.zoom);
      if (snake.boost) {
        const ax = Math.cos(snake.angle);
        const ay = Math.sin(snake.angle);
        ctx.strokeStyle = 'rgba(255, 226, 140, 0.7)';
        ctx.lineWidth = Math.max(2, headR * 0.45);
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - ax * 34 * cam.zoom, hy - ay * 34 * cam.zoom);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      drawName(snake, hx, hy, headR);
      ctx.restore();
    }

    function drawEyes(snake, hx, hy, headR, zoom) {
      const ax = Math.cos(snake.angle);
      const ay = Math.sin(snake.angle);
      const px = -ay;
      const py = ax;
      for (const side of [-1, 1]) {
        const ex = hx + ax * headR * 0.18 + px * headR * 0.28 * side;
        const ey = hy + ay * headR * 0.18 + py * headR * 0.28 * side;
        ctx.beginPath();
        ctx.fillStyle = '#ffffff';
        ctx.arc(ex, ey, Math.max(1.4, 2.5 * zoom), 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = '#102028';
        ctx.arc(ex + ax * 1.1 * zoom, ey + ay * 1.1 * zoom, Math.max(0.8, 1.3 * zoom), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawName(snake, hx, hy, headR) {
      const label = snake.connected === false ? `${snake.name} · пауза` : snake.name;
      ctx.font = '700 13px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.72)';
      ctx.strokeText(label, hx, hy - headR - 6);
      ctx.fillStyle = '#f4fff8';
      ctx.fillText(label, hx, hy - headR - 6);
    }

    function drawBeacon(scene, cam, view) {
      const beacon = scene.beacon;
      const [x, y] = worldToScreen(beacon.x, beacon.y, cam, view);
      const pulse = (16 + Math.sin(scene.time / 180) * 3) * cam.zoom;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([7, 7]);
      ctx.strokeStyle = 'rgba(214, 255, 74, 0.28)';
      ctx.lineWidth = 1.5;
      ctx.arc(x, y, (scene.beaconRange || 170) * cam.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.strokeStyle = '#d6ff4a';
      ctx.lineWidth = 2;
      ctx.arc(x, y, pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = '#d6ff4a';
      ctx.arc(x, y, 5 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
      const caption = beacon.ownerName ? `маяк v${beacon.version} · ${beacon.ownerName}` : `маяк v${beacon.version}`;
      ctx.font = '12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f3ffd0';
      ctx.fillText(caption, x, y - pulse - 8);
      ctx.restore();
    }

    function drawParticles(scene, cam, view) {
      for (const particle of scene.particles) {
        const [sx, sy] = worldToScreen(particle.x, particle.y, cam, view);
        ctx.globalAlpha = Math.max(0, particle.life / particle.max);
        ctx.fillStyle = particle.color;
        ctx.beginPath();
        ctx.arc(sx, sy, particle.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawOutside(scene, cam, view) {
      const [cx, cy] = worldToScreen(0, 0, cam, view);
      const radius = scene.worldRadius * cam.zoom;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, view.w, view.h);
      ctx.arc(cx, cy, radius, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fill('evenodd');
      ctx.restore();
    }

    function drawBorder(scene, cam, view) {
      const [cx, cy] = worldToScreen(0, 0, cam, view);
      ctx.beginPath();
      ctx.arc(cx, cy, scene.worldRadius * cam.zoom, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 93, 115, 0.9)';
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    function drawDanger(scene, cam, view) {
      const dist = Math.hypot(cam.x, cam.y);
      const edge = (dist - scene.worldRadius * 0.78) / (scene.worldRadius * 0.22);
      if (edge <= 0) return;
      ctx.save();
      ctx.fillStyle = `rgba(255, 70, 90, ${Math.min(0.28, edge * 0.28)})`;
      const [cx, cy] = worldToScreen(0, 0, cam, view);
      ctx.beginPath();
      ctx.arc(cx, cy, scene.worldRadius * cam.zoom, 0, Math.PI * 2);
      ctx.lineWidth = 28;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
      ctx.restore();
    }

    function drawMinimap(scene, view) {
      const size = view.w < 820 ? 120 : 168;
      const pad = 16;
      const x = view.w - size - pad;
      const y = view.h - size - pad;
      const cx = x + size / 2;
      const cy = y + size / 2;
      const mapR = size / 2 - 10;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(6, 16, 22, 0.86)';
      ctx.fillRect(x, y, size, size);
      ctx.beginPath();
      ctx.arc(cx, cy, mapR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 93, 115, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      const scale = mapR / scene.worldRadius;
      let shown = 0;
      for (const food of scene.foods) {
        if ((shown++ % 3) !== 0 && food.kind !== 'gold') continue;
        ctx.fillStyle = food.kind === 'gold' ? '#ffd60a' : 'rgba(255,255,255,0.35)';
        ctx.fillRect(cx + food.x * scale, cy + food.y * scale, food.kind === 'gold' ? 3 : 1.5, food.kind === 'gold' ? 3 : 1.5);
      }
      if (scene.beacon) {
        ctx.fillStyle = '#d6ff4a';
        ctx.fillRect(cx + scene.beacon.x * scale - 2, cy + scene.beacon.y * scale - 2, 4, 4);
      }
      for (const snake of scene.snakes) {
        ctx.strokeStyle = snake.color || '#fff';
        ctx.lineWidth = snake.id === scene.selfId ? 2.4 : 1.3;
        ctx.beginPath();
        const pts = snake.points || [];
        const step = Math.max(1, Math.floor(pts.length / 18));
        for (let i = 0; i < pts.length; i += step) {
          const px = cx + pts[i][0] * scale;
          const py = cy + pts[i][1] * scale;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2 - 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(214, 255, 74, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function isNear(points, cam, view, pad) {
      for (let i = 0; i < points.length; i += 3) {
        const [sx, sy] = worldToScreen(points[i][0], points[i][1], cam, view);
        if (sx >= -pad && sy >= -pad && sx <= view.w + pad && sy <= view.h + pad) return true;
      }
      return false;
    }

    return { resize, draw };
  }

  global.SlitherRender = { createRenderer };
})(window);
