# Dashboard de picking

Dashboard de líneas picadas por día, sucursal, usuario y área. Publicado en https://dashboard-picking.netlify.app

## Estructura

- `public/index.html`: la página. Lee el Excel en el navegador y envía al servidor solo los conteos por día. Acepta:
  1. El reporte detallado del WMS (una fila = una línea picada, columnas Fecha, usuario, Sucursal Dest, Area).
  2. Un resumen con hojas "x sucursal", "x usuario", "x area" y "usuario x area".
- `netlify/functions/data.mjs`: API `/api/data`. GET devuelve `{days}`; POST `{days}` reemplaza solo esos días; POST `{check:true}` comprueba la clave. Guarda en Netlify Blobs (store `picking-data`, clave `days`).
- `netlify.toml`: carpeta pública, carpeta de funciones y encabezados noindex.

## Claves (Netlify > Project configuration > Environment variables)

- `VIEW_KEY`: clave para ver. Si no existe, el dashboard es público para ver.
- `UPLOAD_KEY`: clave para cargar. Si no existe, la carga queda desactivada.
- Después de crear o cambiar una clave hay que volver a publicar.

## Publicar (PowerShell)

```powershell
npm.cmd install
npx.cmd netlify-cli deploy --prod --site ade7de4e-c5e3-4a23-b00b-684fdec29841
```

No publicar arrastrando el `index.html` a Netlify: eso deja el sitio sin la función y la página queda "Sin conexión".

## Formato por día

`s=[[sucursal,lineas]]`, `u=[[usuario,lineas]]`, `a=[[area,lineas]]`, `ua=[[area,usuario,lineas]]`
