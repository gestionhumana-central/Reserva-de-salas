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
  SUPABASE_URL: "https://celctsqcwsqdczgbbfsu.supabase.co/rest/v1/",
  SUPABASE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbGN0c3Fjd3NxZGN6Z2JiZnN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNDEzMjgsImV4cCI6MjEwODcxNzMyOH0.VSIMKXl7Vy3VMCNV6aPV1PMzNKF_RGn5TOnPiYbyFBI"
};
