// ==========================================================
// CONFIGURACIÓN DE CONEXIÓN A SUPABASE
// ==========================================================
// Supabase → Project Settings → API (o "Connect"):
//   · Project URL
//   · Publishable key (en proyectos antiguos: "anon public" key)
// Esta clave ES PÚBLICA por diseño: se puede subir a GitHub sin
// riesgo, porque las tablas están bloqueadas y todo pasa por las
// funciones validadas del servidor.
// NUNCA pongas aquí la "secret key" ni la "service_role key".

window.APP_CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_KEY: "TU-PUBLISHABLE-KEY"
};
