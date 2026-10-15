// API del dashboard de picking: guarda y entrega los datos por día.
// GET  /api/data  -> { days: { "AAAA-MM-DD": { s:[[sucursal,lineas]], u:[[usuario,lineas]], a:[[area,lineas]], ua:[[area,usuario,lineas]],
//                                               h:[[usuario,inicio,fin,lineas]], hh:[[hora,lineas]] } } }
//                    h = horas de picking (inicio y fin en segundos desde las 00:00); hh = líneas por hora del día. Opcionales.
// POST /api/data  -> body { days: {...} }  (reemplaza solo los días enviados; los demás se conservan)
//                    body { check: true }  (solo comprueba la clave de carga)
//
// Claves (se configuran en Netlify: Project configuration > Environment variables):
//   VIEW_KEY   = clave para ver. Si no existe, cualquiera con el link puede ver.
//   UPLOAD_KEY = clave para cargar datos. Si no existe, la carga queda desactivada.
// La página las envía en los encabezados x-view-key y x-upload-key.
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const KEY = "days";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const txt = (v) => typeof v === "string" && v.trim() !== "" && v.length <= 120;
const num = (v) => typeof v === "number" && Number.isFinite(v);
const sha = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => !!a && !!b && timingSafeEqual(sha(a), sha(b));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function cleanDay(d) {
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

export default async (req) => {
  const VIEW = process.env.VIEW_KEY || "";
  const UP = process.env.UPLOAD_KEY || "";
  const store = getStore({ name: "picking-data", consistency: "strong" });

  if (req.method === "GET") {
    if (VIEW) {
      const k = req.headers.get("x-view-key") || "";
      if (!same(k, VIEW) && !same(k, UP)) { await wait(600); return json({ error: "clave", need: "view" }, 401); }
    }
    const days = (await store.get(KEY, { type: "json" })) || {};
    return json({ days });
  }

  if (req.method === "POST") {
    if (!UP) return json({ error: "La carga está desactivada: falta configurar UPLOAD_KEY en Netlify." }, 403);
    if (!same(req.headers.get("x-upload-key") || "", UP)) { await wait(600); return json({ error: "Clave de carga incorrecta.", need: "upload" }, 401); }
    let body;
    try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    if (body && body.check === true) return json({ ok: true });
    const inc = body && body.days;
    if (!inc || typeof inc !== "object" || Array.isArray(inc)) return json({ error: "Falta 'days'" }, 400);
    const clean = {};
    for (const [date, d] of Object.entries(inc)) {
      if (!DATE.test(date)) continue;
      const c = cleanDay(d);
      if (c) clean[date] = c;
    }
    const n = Object.keys(clean).length;
    if (!n) return json({ error: "No hay días válidos para guardar" }, 400);
    const days = (await store.get(KEY, { type: "json" })) || {};
    Object.assign(days, clean);
    await store.setJSON(KEY, days);
    return json({ ok: true, saved: n, total: Object.keys(days).length });
  }

  return new Response("Método no permitido", { status: 405 });
};

export const config = { path: "/api/data" };
