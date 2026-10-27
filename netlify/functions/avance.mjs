// API del avance de picking del día: /api/avance
//
// GET                    -> { index, snap, ops, fv }  índice de días con avance, último avance, operadores y versión de cada foto
// GET  ?dia=AAAA-MM-DD   -> { snap }                  avance guardado de ese día
// GET  ?fotos=1          -> { fotos: { usuario: "data:image/jpeg;base64,..." } }
// POST (cuerpo = CSV Allocation tal cual sale del WMS) -> lee el reporte y guarda el avance de su día
//        encabezados: x-upload-key o x-auto-key; x-origen: manual | auto; x-archivo: nombre; x-forzar: 1 (solo encargado)
// POST JSON (solo clave de carga):
//        { accion: "probar" }                       comprueba la clave (también acepta x-auto-key)
//        { accion: "cerrar", dia, hora }            pasa al historial las líneas Finalizada del avance de ese día
//        { accion: "operadores", lista: [{u, nombre, area}] }
//        { accion: "foto", u, img: "data:image/jpeg;base64,..." } / { accion: "borrarfoto", u }
//
// Claves (Netlify > Project configuration > Environment variables):
//   VIEW_KEY   = ver (igual que /api/data)
//   UPLOAD_KEY = encargado: sube reportes, cierra días, operadores y fotos
//   AUTO_KEY   = solo para el script automático: únicamente sube el reporte de avance (no cierra días ni toca el historial)
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import { leerAllocation, decode } from "../lib/allocation.mjs";
import { cleanDay } from "../lib/days.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const USER = /^[a-z0-9._-]{2,40}$/;
const MAXCSV = 6 * 1024 * 1024;

const sha = (s) => createHash("sha256").update(String(s)).digest();
const same = (a, b) => !!a && !!b && timingSafeEqual(sha(a), sha(b));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export default async (req) => {
  const VIEW = process.env.VIEW_KEY || "", UP = process.env.UPLOAD_KEY || "", AUTO = process.env.AUTO_KEY || "";
  const st = getStore({ name: "picking-avance", consistency: "strong" });
  const fotos = getStore({ name: "picking-fotos", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (VIEW) {
      const k = req.headers.get("x-view-key") || "";
      if (!same(k, VIEW) && !same(k, UP)) { await wait(600); return json({ error: "clave", need: "view" }, 401); }
    }
    if (url.searchParams.get("fotos")) {
      const out = {};
      const { blobs } = await fotos.list();
      await Promise.all(blobs.map(async (b) => { const v = await fotos.get(b.key); if (v) out[b.key] = v; }));
      return json({ fotos: out });
    }
    const dia = url.searchParams.get("dia");
    if (dia) {
      if (!DATE.test(dia)) return json({ error: "Fecha inválida" }, 400);
      return json({ snap: (await st.get("snap/" + dia, { type: "json" })) || null });
    }
    const index = (await st.get("index", { type: "json" })) || {};
    const ultimo = Object.keys(index).sort().pop();
    const snap = ultimo ? await st.get("snap/" + ultimo, { type: "json" }) : null;
    const op = (await st.get("operadores", { type: "json" })) || { lista: [], fv: {} };
    return json({ index, snap, ops: op.lista, fv: op.fv || {} });
  }

  if (req.method !== "POST") return new Response("Método no permitido", { status: 405 });

  const kUp = req.headers.get("x-upload-key") || "", kAuto = req.headers.get("x-auto-key") || "";
  const esEncargado = !!UP && same(kUp, UP);
  const esAuto = !!AUTO && same(kAuto, AUTO);
  if (!esEncargado && !esAuto) {
    if (!UP && !AUTO) return json({ error: "La carga está desactivada: falta configurar UPLOAD_KEY en Netlify." }, 403);
    await wait(600);
    return json({ error: kAuto ? "Clave automática incorrecta (AUTO_KEY)." : "Clave de carga incorrecta.", need: "upload" }, 401);
  }

  const ct = (req.headers.get("content-type") || "").toLowerCase();

  // ----- JSON: acciones -----
  if (ct.includes("application/json")) {
    let b;
    try { b = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
    const acc = b && b.accion;
    if (acc === "probar") return json({ ok: true, rol: esEncargado ? "encargado" : "auto" });
    if (!esEncargado) return json({ error: "La clave automática solo puede subir el reporte de avance." }, 403);

    if (acc === "cerrar") {
      const dia = String(b.dia || "");
      if (!DATE.test(dia)) return json({ error: "Fecha inválida" }, 400);
      const snap = await st.get("snap/" + dia, { type: "json" });
      if (!snap) return json({ error: "No hay avance guardado para ese día." }, 404);
      if (b.hora !== snap.hora) return json({ error: "Llegó un reporte más nuevo mientras revisabas. Volvé a abrir el cierre.", hora: snap.hora }, 409);
      const limpio = cleanDay(snap.hist);
      if (!limpio) return json({ error: "Ese día no tiene líneas picadas para guardar." }, 400);
      const data = getStore({ name: "picking-data", consistency: "strong" });
      const days = (await data.get("days", { type: "json" })) || {};
      days[dia] = limpio;
      await data.setJSON("days", days);
      const index = (await st.get("index", { type: "json" })) || {};
      const lin = limpio.u.reduce((s, x) => s + x[1], 0);
      index[dia] = { ...(index[dia] || {}), cerrado: new Date().toISOString(), cHora: snap.hora, cFin: snap.fin, cTot: snap.tot, cLineas: lin, cambio: false };
      await st.setJSON("index", index);
      return json({ ok: true, dia, lineas: lin });
    }

    if (acc === "operadores") {
      if (!Array.isArray(b.lista)) return json({ error: "Falta la lista" }, 400);
      const vis = new Set(), lista = [];
      for (const o of b.lista) {
        const u = String(o && o.u || "").trim().toLowerCase();
        if (!USER.test(u) || vis.has(u)) continue;
        vis.add(u);
        lista.push({ u, nombre: String(o.nombre || "").trim().slice(0, 80), area: String(o.area || "").trim().toUpperCase().slice(0, 12) });
      }
      if (!lista.length) return json({ error: "La lista no tiene usuarios válidos." }, 400);
      const op = (await st.get("operadores", { type: "json" })) || { lista: [], fv: {} };
      op.lista = lista;
      await st.setJSON("operadores", op);
      return json({ ok: true, n: lista.length });
    }

    if (acc === "foto" || acc === "borrarfoto") {
      const u = String(b.u || "").trim().toLowerCase();
      if (!USER.test(u)) return json({ error: "Usuario inválido" }, 400);
      const op = (await st.get("operadores", { type: "json" })) || { lista: [], fv: {} };
      op.fv = op.fv || {};
      if (acc === "borrarfoto") { await fotos.delete(u); delete op.fv[u]; }
      else {
        const img = String(b.img || "");
        const m = img.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (!m || img.length > 400000) return json({ error: "La foto debe ser JPEG y de menos de 300 KB." }, 400);
        const bin = Buffer.from(m[1], "base64");
        if (bin[0] !== 0xff || bin[1] !== 0xd8) return json({ error: "La foto no es un JPEG válido." }, 400);
        await fotos.set(u, img);
        op.fv[u] = Date.now();
      }
      await st.setJSON("operadores", op);
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  }

  // ----- CSV: reporte Allocation -----
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) return json({ error: "Archivo vacío" }, 400);
  if (buf.length > MAXCSV) return json({ error: "El archivo pasa de 6 MB." }, 413);
  let r;
  try { r = leerAllocation(decode(buf)); } catch (e) { return json({ error: e.message }, 422); }

  const archivo = (() => { try { return decodeURIComponent(req.headers.get("x-archivo") || ""); } catch { return ""; } })().slice(0, 120);
  const origen = esEncargado && req.headers.get("x-origen") !== "auto" ? "manual" : "auto";
  const forzar = esEncargado && req.headers.get("x-forzar") === "1";

  const index = (await st.get("index", { type: "json" })) || {};
  const prev = index[r.dia];
  if (prev && r.hora < prev.hora && !forzar) {
    return json({ error: "mas_antiguo", detalle: "Ya hay un reporte más nuevo de ese día.", dia: r.dia, hora: r.hora, actual: prev.hora }, 409);
  }
  const rep = r.repetidas;
  const snap = { ...r, repetidas: rep.slice(0, 50), nRepetidas: rep.reduce((s, x) => s + x.veces - 1, 0), archivo, origen, subido: new Date().toISOString() };
  await st.setJSON("snap/" + r.dia, snap);
  const cambio = prev && prev.cerrado ? (prev.cambio || r.fin !== prev.cFin || r.tot !== prev.cTot) : false;
  index[r.dia] = { ...(prev || {}), dia: r.dia, hora: r.hora, fin: r.fin, tot: r.tot, archivo, origen, subido: snap.subido, cambio };
  await st.setJSON("index", index);
  return json({ ok: true, dia: r.dia, hora: r.hora, fin: r.fin, tot: r.tot, pend: r.pend, areas: r.areas,
    avisos: { estadosRaros: r.estadosRaros, otras: r.otras, finOtroDia: r.finOtroDia, finSinUsuario: r.finSinUsuario, finSinHora: r.finSinHora, repetidas: snap.nRepetidas }, cambioTrasCierre: cambio });
};

export const config = { path: "/api/avance" };
