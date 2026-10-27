// Lectura del reporte "Allocation" del WMS (CSV tal cual se descarga, separado por ;).
// Una fila = una línea de picking. Se usa en el servidor (función /api/avance) para el avance del día
// y para armar el día que pasa al historial al presionar "Cerrar día".
//
// Reglas (confirmadas por el encargado, oct-2026):
//  - Área = prefijo de "Ubicación de selección" (LP1-03-17-04-05 -> LP1). Solo cuentan AREAS; las demás se informan aparte.
//  - Operador = "Usua Pick".
//  - Picada = estado Finalizada. Pendiente = Asignado o Iniciado. Otro estado: no se cuenta y se avisa.
//  - % avance = picadas ÷ (picadas + pendientes), total y por área.
//  - Filas idénticas en todas sus columnas: se cuentan todas (como las muestra el WMS) y se avisan.
//  - Historial: solo líneas Finalizada de AREAS, en el día de su "Hora de selección".

export const AREAS = ["LP1", "LP2", "RK", "CG", "CF"];

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const COLS = {
  estado: ["estado"],
  user: ["usua pick"],
  ubic: ["ubicacion de seleccion"],
  suc: ["sucursal dest"],
  hsel: ["hora de seleccion"],
  modif: ["fe y hr modif"],
  crea: ["fe y hr crea"],
  onda: ["numero ejecuc"],
};
const REQUIRED = ["estado", "user", "ubic", "suc", "hsel"];

const FIN = new Set(["finalizada", "finalizado"]);
const ASIG = new Set(["asignado", "asignada"]);
const INIC = new Set(["iniciado", "iniciada"]);

// bytes -> texto: UTF-8 si es válido; si no, Windows-1252 (por si algún día el WMS cambia la codificación)
export function decode(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, ""); }
  catch { return new TextDecoder("windows-1252").decode(u8); }
}

// CSV con comillas dobles opcionales; separador detectado en el encabezado (; , o tabulación)
export function parseCSV(text) {
  const nl = text.search(/\r?\n/), first = nl < 0 ? text : text.slice(0, nl);
  const cand = [";", "\t", ","].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1]);
  const sep = cand[0][0];
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f === "") q = true;
    else if (c === sep) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// '="7770108104834"' -> '7770108104834'
const val = (s) => { const t = String(s ?? "").trim(); const m = t.match(/^="(.*)"$/); return m ? m[1] : t; };

// "26/10/2026 16:31:31" -> { d: "2026-10-26", s: segundos desde 00:00 }
export function fechaHora(v) {
  const m = String(v ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = +m[4], mi = +m[5], se = +(m[6] || 0);
  if (+m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12 || h > 23 || mi > 59 || se > 59) return null;
  return { d: `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`, s: h * 3600 + mi * 60 + se };
}

const inc = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

// texto CSV -> resumen del avance + día(s) en formato historial. Lanza Error con mensaje claro si no es el reporte.
export function leerAllocation(text) {
  const rows = parseCSV(text);
  let hi = -1, ix = null;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const h = rows[i].map(norm), o = {};
    for (const [k, names] of Object.entries(COLS)) for (const n of names) { const j = h.indexOf(n); if (j >= 0) { o[k] = j; break; } }
    if (REQUIRED.every((k) => k in o)) { hi = i; ix = o; break; }
  }
  if (hi < 0) throw new Error('No es el reporte Allocation del WMS: faltan las columnas Estado, Usua Pick, Ubicación de selección, Sucursal Dest u Hora de selección.');

  const ncol = rows[hi].length;
  const data = rows.slice(hi + 1).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!data.length) throw new Error("El archivo no tiene líneas.");

  // fecha y hora del reporte = última modificación registrada (si no hay, última hora de selección)
  let ts = null;
  for (const r of data) for (const k of ["modif", "hsel"]) {
    if (ix[k] === undefined) continue;
    const t = fechaHora(r[ix[k]]);
    if (t && (!ts || t.d > ts.d || (t.d === ts.d && t.s > ts.s))) ts = t;
  }
  if (!ts) throw new Error("No se encontró ninguna fecha válida en el reporte.");
  const dia = ts.d;

  const area = new Map();          // área -> {fin, asig, inic}
  const au = new Map();            // área\u0001usuario -> {n, ult}
  const otras = new Map();         // área ajena -> {fin, pend}
  const estadosRaros = new Map();  // estado desconocido -> filas
  const finOtroDia = new Map();    // fecha -> líneas Finalizada de otro día (no cuentan en el avance)
  let finSinUsuario = 0, finSinHora = 0, filasCortas = 0;
  // historial (solo Finalizada de AREAS del día del reporte)
  const H = { s: new Map(), u: new Map(), a: new Map(), ua: new Map(), hu: new Map(), hh: new Map() };
  // filas idénticas
  const vistos = new Map();

  for (const r of data) {
    if (r.length < ncol) filasCortas++;
    const key = r.join("\u0001");
    inc(vistos, key);

    const est = norm(r[ix.estado]);
    const ub = val(r[ix.ubic]);
    const ar = ub.split("-")[0].trim().toUpperCase() || "(sin ubicación)";
    const tipo = FIN.has(est) ? "fin" : ASIG.has(est) ? "asig" : INIC.has(est) ? "inic" : null;

    if (!AREAS.includes(ar)) {
      const o = otras.get(ar) || { fin: 0, pend: 0, otro: 0 };
      if (tipo === "fin") o.fin++; else if (tipo) o.pend++; else o.otro++;
      otras.set(ar, o);
      continue;
    }
    if (!tipo) { inc(estadosRaros, String(r[ix.estado] ?? "").trim() || "(vacío)"); continue; }

    const user = val(r[ix.user]).toLowerCase();
    const hs = fechaHora(r[ix.hsel]);
    if (tipo === "fin" && hs && hs.d !== dia) { inc(finOtroDia, hs.d); continue; }

    const A = area.get(ar) || { fin: 0, asig: 0, inic: 0 };
    A[tipo]++;
    area.set(ar, A);
    if (tipo !== "fin") continue;

    if (!user) { finSinUsuario++; continue; }
    const k = ar + "\u0001" + user;
    const o = au.get(k) || { n: 0, ult: -1 };
    o.n++;
    if (hs && hs.s > o.ult) o.ult = hs.s;
    au.set(k, o);

    if (!hs) { finSinHora++; continue; }
    const suc = val(r[ix.suc]);
    inc(H.s, suc || "(sin sucursal)"); inc(H.u, user); inc(H.a, ar); inc(H.ua, k);
    const t = H.hu.get(user);
    if (t) { if (hs.s < t[0]) t[0] = hs.s; if (hs.s > t[1]) t[1] = hs.s; t[2]++; } else H.hu.set(user, [hs.s, hs.s, 1]);
    inc(H.hh, Math.floor(hs.s / 3600));
  }

  const areas = AREAS.filter((a) => area.has(a)).map((a) => { const o = area.get(a); return { area: a, fin: o.fin, asig: o.asig, inic: o.inic, tot: o.fin + o.asig + o.inic }; });
  const fin = areas.reduce((s, a) => s + a.fin, 0), tot = areas.reduce((s, a) => s + a.tot, 0);
  if (!tot) throw new Error(`El reporte no tiene líneas de las áreas ${AREAS.join(", ")}.`);
  const ops = [...au].map(([k, o]) => { const [a, u] = k.split("\u0001"); return [a, u, o.n, o.ult]; })
    .sort((x, y) => y[2] - x[2] || x[1].localeCompare(y[1]));

  const repetidas = [...vistos].filter(([, n]) => n > 1).map(([k, n]) => {
    const r = k.split("\u0001");
    return { veces: n, ubic: val(r[ix.ubic]), suc: val(r[ix.suc]), estado: String(r[ix.estado] ?? "").trim() };
  });

  const ent = (m) => [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const histDia = {
    s: ent(H.s), u: ent(H.u), a: ent(H.a),
    ua: ent(H.ua).map(([k, n]) => [...k.split("\u0001"), n]),
    h: [...H.hu].map(([u, t]) => [u, t[0], t[1], t[2]]).sort((a, b) => a[0].localeCompare(b[0])),
    hh: [...H.hh].sort((a, b) => a[0] - b[0]),
  };

  return {
    dia, hora: ts.s, filas: data.length,
    fin, tot, pend: tot - fin,
    areas, ops,
    otras: [...otras].map(([a, o]) => ({ area: a, ...o })).sort((x, y) => (y.fin + y.pend + y.otro) - (x.fin + x.pend + x.otro)),
    estadosRaros: ent(estadosRaros),
    finOtroDia: ent(finOtroDia),
    finSinUsuario, finSinHora, filasCortas,
    repetidas,
    hist: histDia,   // día del reporte en el formato del historial (solo Finalizada con usuario y hora)
  };
}
