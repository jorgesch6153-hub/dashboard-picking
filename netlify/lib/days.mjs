// Validación de un día del historial para el "Cerrar día" de /api/avance.
// COPIA EXACTA de cleanDay() de netlify/functions/data.mjs: si se cambia allí, cambiarla aquí también.
const txt = (v) => typeof v === "string" && v.trim() !== "" && v.length <= 120;
const num = (v) => typeof v === "number" && Number.isFinite(v);

export function cleanDay(d) {
  if (!d || typeof d !== "object") return null;
  const out = { s: [], u: [], a: [], ua: [], h: [], hh: [] };
  for (const k of ["s", "u", "a"]) {
    if (!Array.isArray(d[k])) continue;
    for (const r of d[k]) if (Array.isArray(r) && txt(r[0]) && num(r[1])) out[k].push([r[0].trim(), r[1]]);
  }
  if (Array.isArray(d.ua)) {
    for (const r of d.ua) if (Array.isArray(r) && txt(r[0]) && txt(r[1]) && num(r[2])) out.ua.push([r[0].trim(), r[1].trim(), r[2]]);
  }
  if (Array.isArray(d.h)) {
    for (const r of d.h) if (Array.isArray(r) && txt(r[0]) && Number.isInteger(r[1]) && Number.isInteger(r[2]) && num(r[3]) && r[1] >= 0 && r[1] <= r[2] && r[2] < 86400 && r[3] > 0) out.h.push([r[0].trim(), r[1], r[2], r[3]]);
  }
  if (Array.isArray(d.hh)) {
    for (const r of d.hh) if (Array.isArray(r) && Number.isInteger(r[0]) && r[0] >= 0 && r[0] < 24 && num(r[1])) out.hh.push([r[0], r[1]]);
  }
  if (!out.h.length) delete out.h;
  if (!out.hh.length) delete out.hh;
  return out.s.length || out.u.length || out.a.length || out.ua.length ? out : null;
}
