"use strict";

// ==========================================================
// RESERVA DE SALAS — Frontend (Supabase)
// ==========================================================
// El navegador solo muestra datos y envía solicitudes. Toda la
// validación (disponibilidad, sede→sala, empresa→unidad, 30 días,
// permisos de cancelación) se repite en el servidor.
//
// Vistas:
//  · Línea de tiempo del día: salas en filas y horas en columnas;
//    clic en un espacio libre para armar la reserva.
//  · Salas: fichas con estado (libre / ocupada), capacidad,
//    equipamiento y filtros.
// Formulario de reserva rápida: duraciones en un clic, hora de fin
// automática, próximos horarios libres y datos recordados.

const ZONA_HORARIA = "America/Lima";
const DURACIONES = [30, 60, 90, 120];      // minutos; además "otra"
const DIAS_EN_CHIPS = 7;                   // hoy + 6 días
const MOVIL = window.matchMedia("(max-width: 760px)");
const UNA_COLUMNA = window.matchMedia("(max-width: 860px)");
// Con una sola columna, la zona fija (sede, fecha y línea de tiempo) debe
// dejar libre al menos este espacio para ir llenando el formulario debajo.
const ESPACIO_FORMULARIO = 260;   // píxeles
const ZONA_FIJA_MAX = 0.65;       // y no ocupar más de esta fracción

const CAMPOS_OBLIGATORIOS = [
  { id: "nombre", etiqueta: "Nombre" },
  { id: "apellido", etiqueta: "Apellido" },
  { id: "empresa", etiqueta: "Empresa" },
  { id: "unidad", etiqueta: "Unidad/Área" },
  { id: "sede", etiqueta: "Sede" },
  { id: "fecha", etiqueta: "Fecha" },
  { id: "sala", etiqueta: "Sala" },
  { id: "horaInicio", etiqueta: "Hora Inicio" },
  { id: "horaFin", etiqueta: "Hora Fin" },
  { id: "codigo", etiqueta: "Código de Seguridad (4 dígitos)" }
];

const $ = (id) => document.getElementById(id);

let sb = null;
let sesionActual = null;
let esAdminActual = false;

// Estado de la pantalla.
const estado = {
  cfg: { inicio: "08:00", fin: "20:00", intervalo: 15, maxDias: 30, hoy: null, ahora: null },
  ahoraCargado: 0,          // Date.now() cuando llegó la hora del servidor
  sedes: [],
  vista: "tiempo",
  duracion: 60,             // minutos o "otra"
  filtros: { libresAhora: false, tv: false, capMin: 0 },
  salasPorSede: {},         // caché de obtener_salas_detalle
  dia: null                 // { fisicas, reservas, salas, libres }
};

// Evita que una respuesta lenta pise a una más reciente cuando el
// usuario cambia rápido de opción.
const turnos = {};
const nuevoTurno = (clave) => (turnos[clave] = (turnos[clave] || 0) + 1);
const turnoVigente = (clave, t) => turnos[clave] === t;

document.addEventListener("DOMContentLoaded", iniciar);

// ---------- Inicio ----------

async function iniciar() {

  const cfg = window.APP_CONFIG || {};

  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("TU-PROYECTO") ||
      !cfg.SUPABASE_KEY || cfg.SUPABASE_KEY.includes("TU-")) {
    mostrarAvisoConfig("Falta configurar la conexión a Supabase en js/config.js.");
    return;
  }

  const urlBase = cfg.SUPABASE_URL.trim().replace(/\/+(rest|auth)\/v1\/?$/, "").replace(/\/+$/, "");
  sb = window.supabase.createClient(urlBase, cfg.SUPABASE_KEY.trim());

  estado.vista = leerLocal("vistaReserva") || (MOVIL.matches ? "salas" : "tiempo");
  mostrarVista(estado.vista);
  cargarDatosLocal();
  registrarEventos();
  iniciarZonaFija();
  renderChipsDuracion();

  try {
    await asegurarSesion();
    await actualizarBarraSesion();
    await Promise.all([cargarConfig(), cargarEmpresas(), cargarSedes()]);
    await restaurarEmpresaYUnidad();
  } catch (e) {
    mostrarErrorGenerico(e);
    return;
  }

  elegirFecha(estado.cfg.hoy, false);
  const sedeGuardada = leerLocal("sedeReserva");
  if (sedeGuardada && estado.sedes.includes(sedeGuardada)) elegirSede(sedeGuardada);
  else renderTodo();

  sb.auth.onAuthStateChange((_evento, session) => {
    sesionActual = session;
    // Fuera del callback, para no bloquear al cliente de Supabase.
    setTimeout(() => {
      actualizarBarraSesion();
      cargarDia();
    }, 0);
  });

  // Al volver a la pestaña, la disponibilidad se refresca.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") cargarDia();
  });
}

function registrarEventos() {
  $("empresa").addEventListener("change", alCambiarEmpresa);
  $("sala").addEventListener("change", () => { actualizarHorasInicio(); });
  $("horaInicio").addEventListener("change", () => { actualizarHorasFin(); });
  $("horaFin").addEventListener("change", sincronizarSeleccion);
  $("fecha").addEventListener("change", () => elegirFecha($("fecha").value, true));
  $("botonReservar").addEventListener("click", reservar);
  $("botonCambiarPersona").addEventListener("click", () => mostrarCamposPersona(true, true));
  $("botonIrFormulario").addEventListener("click", irAlFormulario);
  $("formReserva").addEventListener("submit", (ev) => { ev.preventDefault(); reservar(); });

  $("botonEnviarEnlace").addEventListener("click", iniciarSesionAdmin);
  ["loginCorreo", "loginClave"].forEach((id) =>
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); iniciarSesionAdmin(); }
    }));
  $("botonAnularCodigo").addEventListener("click", anularConCodigo);
  // Acceso del administrador: estrella discreta en la esquina inferior derecha.
  $("accesoAdmin").addEventListener("click", abrirAccesoAdmin);

  // Código: solo dígitos. Se trata como texto, así que el 0 inicial se conserva (0251).
  ["codigo", "anularCodigo"].forEach((id) =>
    $(id).addEventListener("input", (ev) => {
      ev.target.value = normalizarCodigo(ev.target.value);
    }));
  $("anularCodigo").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault(); // evita que el Enter "pulse" también el botón del mensaje siguiente
      anularConCodigo();
    }
  });

  // Botones "Cerrar"/"Volver" de todos los modales.
  document.querySelectorAll("[data-cerrar]").forEach((b) =>
    b.addEventListener("click", () => cerrarModal(b.dataset.cerrar)));

  // Pestañas de vista.
  document.querySelectorAll(".pestana").forEach((b) =>
    b.addEventListener("click", () => {
      mostrarVista(b.dataset.vista);
      guardarLocal("vistaReserva", b.dataset.vista);
    }));

  // Chips (delegación: se regeneran).
  $("chipsSede").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-sede]");
    if (b) elegirSede(b.dataset.sede);
  });
  $("chipsFecha").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-fecha]");
    if (b) elegirFecha(b.dataset.fecha, true);
  });
  $("chipsDuracion").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-duracion]");
    if (b && !b.disabled) aplicarDuracion(b.dataset.duracion === "otra" ? "otra" : Number(b.dataset.duracion));
  });
  $("filtrosSalas").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-filtro]");
    if (!b) return;
    const f = b.dataset.filtro;
    if (f === "libresAhora") estado.filtros.libresAhora = !estado.filtros.libresAhora;
    if (f === "tv") estado.filtros.tv = !estado.filtros.tv;
    if (f === "cap") {
      const v = Number(b.dataset.valor);
      estado.filtros.capMin = estado.filtros.capMin === v ? 0 : v;
    }
    renderSalas();
  });

  // Línea de tiempo: clic en un espacio libre o en la "x" de una reserva.
  $("lineaTiempo").addEventListener("click", (ev) => {
    const x = ev.target.closest(".boton-x");
    if (x) { alPulsarEliminar(x.dataset); return; }
    const celda = ev.target.closest(".lt-celda.libre");
    if (celda) seleccionar(celda.dataset.sala, aMin(celda.dataset.hora));
  });

  // Fichas de sala.
  $("fichasSalas").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-accion]");
    if (!b) return;
    if (b.dataset.accion === "reservar") seleccionar(b.dataset.sala, Number(b.dataset.min), true);
    if (b.dataset.accion === "agenda") mostrarVista("tiempo");
  });

  // Sugerencias.
  $("listaSugerencias").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-sala]");
    if (b) seleccionar(b.dataset.sala, Number(b.dataset.min), true);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    document.querySelectorAll(".modal-overlay").forEach((m) => {
      if (m.style.display !== "none" && m.id !== "modalConfirmar") m.style.display = "none";
    });
  });
}

// ---------- Zona fija ----------
// Al bajar hasta el formulario, la sede, la fecha y la línea de tiempo
// se quedan visibles arriba (position: sticky en CSS).

function iniciarZonaFija() {
  const zona = $("zonaFija");
  if (window.ResizeObserver) new ResizeObserver(actualizarZonaFija).observe(zona);
  window.addEventListener("resize", actualizarZonaFija);
  window.addEventListener("scroll", marcarZonaPegada, { passive: true });
  actualizarZonaFija();
}

function actualizarZonaFija() {
  const zona = $("zonaFija");
  const estilo = getComputedStyle(zona);
  const relleno = parseFloat(estilo.paddingTop) + parseFloat(estilo.paddingBottom);
  const alto = zona.offsetHeight - relleno;
  // Dos columnas: el formulario está al lado, basta con que la zona quepa.
  // Una columna: el formulario pasa por debajo y necesita espacio.
  const barra = $("barraMovil").offsetHeight;      // 0 si no se muestra
  const disponible = window.innerHeight - barra;
  const maximo = UNA_COLUMNA.matches
    ? Math.min(disponible * ZONA_FIJA_MAX, disponible - ESPACIO_FORMULARIO)
    : window.innerHeight - relleno;
  const tiempo = $("vistaTiempo");
  // Distancia desde el inicio del contenido de la zona hasta la línea de tiempo.
  const inicioTiempo = tiempo.hidden ? 0 : tiempo.getBoundingClientRect().top -
    zona.getBoundingClientRect().top - parseFloat(estilo.paddingTop);

  let modo = null;                         // null = no se fija
  if (alto > 0 && alto <= maximo) {
    modo = "todo";                         // se queda todo: sede, fecha y línea de tiempo
  } else if (inicioTiempo > 0 && alto - inicioTiempo <= maximo) {
    modo = "tiempo";                       // no cabe todo: se queda solo la línea de tiempo
  }

  zona.classList.toggle("fija", modo !== null);
  const rellenoArriba = parseFloat(getComputedStyle(zona).paddingTop);
  const tope = modo === "tiempo" ? -(inicioTiempo + rellenoArriba - 8) : 0;
  zona.style.top = modo === "tiempo" ? tope + "px" : "";
  // Con una sola columna, al llevar la vista a un campo del formulario el
  // navegador deja libre el espacio que ocupa la zona.
  const visible = modo === null ? 0 : zona.offsetHeight + tope;
  document.documentElement.style.setProperty("--alto-fija",
    UNA_COLUMNA.matches ? visible + "px" : "0px");
  marcarZonaPegada();
}

function marcarZonaPegada() {
  const zona = $("zonaFija");
  const tope = parseFloat(zona.style.top) || 0;
  const pegada = zona.classList.contains("fija") && window.scrollY > 0 &&
    zona.getBoundingClientRect().top <= tope + 0.5;
  zona.classList.toggle("pegada", pegada);
}

// ---------- Sesión ----------
// Cada visitante recibe una sesión anónima automática (queda en su
// navegador). Esa identidad es la que el servidor guarda como
// creador de la reserva; nadie la escribe a mano.

async function asegurarSesion() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    sesionActual = data.session;
    return;
  }
  const { data: anon, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  sesionActual = anon.session;
}

async function actualizarBarraSesion() {
  const barra = $("barraSesion");
  const usuario = sesionActual && sesionActual.user;
  // Puede llamarse dos veces seguidas (al iniciar sesión y por el aviso de
  // cambio de sesión); solo la llamada más reciente escribe la barra.
  const t = nuevoTurno("barra");

  if (!usuario || usuario.is_anonymous) {
    esAdminActual = false;
    barra.replaceChildren(
      texto("Para eliminar una reserva, haz clic en su \"x\" y coloca tu código de 4 dígitos.")
    );
    return;
  }

  let esAdmin = false;
  try {
    esAdmin = !!(await rpc("soy_admin"));
  } catch (e) {
    console.error(e);
  }

  if (!turnoVigente("barra", t)) return;

  esAdminActual = esAdmin;
  barra.replaceChildren(
    texto("Sesión iniciada: " + (usuario.email || "") + (esAdmin ? " (administrador)" : "")),
    botonEnlace("Cerrar sesión", cerrarSesion)
  );
}

// Acceso de administrador con correo + código (contraseña de Supabase Auth).
// El servidor decide quién es administrador (tabla "administradores");
// si la cuenta no lo es, se cierra la sesión y no se habilita nada.
function abrirAccesoAdmin() {
  $("loginCorreo").value = "";
  $("loginClave").value = "";
  $("loginError").textContent = "";
  abrirModal("modalLogin");
}

async function iniciarSesionAdmin() {
  const correo = $("loginCorreo").value.trim();
  const clave = $("loginClave").value;
  const error = (t) => { $("loginError").textContent = t; };

  if (!correo || !clave) {
    error("Ingresa tu correo y tu código.");
    return;
  }

  const boton = $("botonEnviarEnlace");
  boton.disabled = true;
  error("");

  try {
    const { error: fallo } = await sb.auth.signInWithPassword({ email: correo, password: clave });
    if (fallo) {
      $("loginClave").value = "";
      error("Correo o código incorrecto.");
      return;
    }

    let esAdmin = false;
    try { esAdmin = !!(await rpc("soy_admin")); } catch (e) { console.error(e); }

    if (!esAdmin) {
      await cerrarSesion();
      error("Esta cuenta no tiene permisos de administrador.");
      return;
    }

    cerrarModal("modalLogin");
    await actualizarBarraSesion();
    cargarDia();
  } catch (e) {
    console.error(e);
    error("No se pudo conectar. Intenta nuevamente.");
  } finally {
    boton.disabled = false;
  }
}

async function cerrarSesion() {
  await sb.auth.signOut();
  await asegurarSesion();
  await actualizarBarraSesion();
  cargarDia();
}

// ---------- Llamadas al servidor ----------

async function rpc(nombre, params) {
  const { data, error } = await sb.rpc(nombre, params || {});
  if (error) throw error;
  return data;
}

async function cargarConfig() {
  const c = await rpc("obtener_config_horario");
  if (c) Object.assign(estado.cfg, c);
  if (!estado.cfg.hoy) estado.cfg.hoy = hoyLocalISO();
  estado.ahoraCargado = Date.now();
  $("fecha").min = estado.cfg.hoy;
  $("fecha").max = sumarDiasISO(estado.cfg.hoy, estado.cfg.maxDias);
}

async function cargarEmpresas() {
  const empresas = await rpc("obtener_empresas");
  llenarCombo(reiniciarCombo("empresa", false), empresas || []);
}

async function cargarSedes() {
  estado.sedes = (await rpc("obtener_sedes")) || [];
  renderChipsSede();
}

async function salasDeSede(sede) {
  if (!estado.salasPorSede[sede]) {
    estado.salasPorSede[sede] = (await rpc("obtener_salas_detalle", { p_sede: sede })) || [];
  }
  return estado.salasPorSede[sede];
}

// Empresa → Unidad/Área
async function alCambiarEmpresa() {
  const empresa = $("empresa").value;
  const combo = reiniciarCombo("unidad", true);
  const t = nuevoTurno("unidad");

  if (!empresa) return;

  try {
    const unidades = await rpc("obtener_unidades", { p_empresa: empresa });
    if (!turnoVigente("unidad", t)) return;
    llenarCombo(combo, unidades || []);
    combo.disabled = false;
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

// Disponibilidad del día: reservas, salas y horarios libres de cada sala.
async function cargarDia() {
  if (!sb) return;
  const sede = $("sede").value;
  const fecha = $("fecha").value;
  const t = nuevoTurno("dia");

  if (!sede || !fecha) {
    estado.dia = null;
    renderTodo();
    return;
  }

  try {
    const [cal, salas, cfg] = await Promise.all([
      rpc("obtener_calendario", { p_fecha: fecha, p_sede: sede }),
      salasDeSede(sede),
      rpc("obtener_config_horario")
    ]);
    if (!turnoVigente("dia", t)) return;

    if (cfg) { Object.assign(estado.cfg, cfg); estado.ahoraCargado = Date.now(); }

    const fisicas = (cal && cal.salas) || [];
    const nombres = [...new Set([...fisicas, ...salas.map((s) => s.nombre)])];
    const horas = await Promise.all(nombres.map((n) =>
      rpc("obtener_horas_inicio", { p_fecha: fecha, p_sede: sede, p_sala: n })));
    if (!turnoVigente("dia", t)) return;

    const libres = {};
    nombres.forEach((n, i) => { libres[n] = new Set(horas[i] || []); });

    estado.dia = { fisicas, reservas: (cal && cal.reservasPorSala) || {}, salas, libres };
    actualizarComboSalas();
    renderTodo();
  } catch (e) {
    if (!turnoVigente("dia", t)) return;
    console.error(e);
    $("lineaTiempo").innerHTML = '<p class="mensaje-estado">No se pudo cargar la disponibilidad. Intente nuevamente.</p>';
    $("fichasSalas").innerHTML = '<p class="mensaje-estado">No se pudo cargar la disponibilidad. Intente nuevamente.</p>';
  }
}

// ---------- Sede, fecha y vista ----------

function elegirSede(sede) {
  if ($("sede").value !== sede) {
    $("sede").value = sede;
    reiniciarCombo("sala", true);
    limpiarHorasInicioYFin();
  }
  guardarLocal("sedeReserva", sede);
  renderChipsSede();
  cargarDia();
}

function elegirFecha(fecha, recargar) {
  if (!fecha) return;
  $("fecha").value = fecha;
  limpiarHorasInicioYFin();
  renderChipsFecha();
  if (recargar) cargarDia();
}

function mostrarVista(vista) {
  estado.vista = vista === "salas" ? "salas" : "tiempo";
  $("vistaTiempo").hidden = estado.vista !== "tiempo";
  $("vistaSalas").hidden = estado.vista !== "salas";
  document.querySelectorAll(".pestana").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.vista === estado.vista)));
  // Al hacerse visible, la línea de tiempo se redibuja para ubicarse en la hora actual.
  if (estado.vista === "tiempo" && estado.dia) renderLineaTiempo();
}

function irAlFormulario() {
  $("formReserva").scrollIntoView({ behavior: "smooth", block: "start" });
  const vacio = CAMPOS_OBLIGATORIOS.map((c) => $(c.id))
    .find((el) => el && el.type !== "hidden" && !el.disabled && el.offsetParent && !el.value.trim());
  if (vacio) setTimeout(() => vacio.focus({ preventScroll: true }), 350);
}

// ---------- Tiempo ----------

function aMin(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

function aHora(min) {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

function minInicio() { return aMin(estado.cfg.inicio); }
function minFin() { return aMin(estado.cfg.fin); }
function intervalo() { return Number(estado.cfg.intervalo) || 15; }
function esHoy() { return $("fecha").value === estado.cfg.hoy; }

// Minutos actuales en Lima (hora del servidor + tiempo transcurrido).
function ahoraMin() {
  if (!estado.cfg.ahora) return -1;
  return aMin(estado.cfg.ahora) + Math.floor((Date.now() - estado.ahoraCargado) / 60000);
}

function slots() {
  const lista = [];
  for (let m = minInicio(); m < minFin(); m += intervalo()) lista.push(m);
  return lista;
}

// Un bloque ya terminado de hoy no se puede reservar.
function esPasado(min) {
  return esHoy() && min + intervalo() <= ahoraMin();
}

function libre(sala, min) {
  const d = estado.dia;
  return !!(d && d.libres[sala] && d.libres[sala].has(aHora(min)) && !esPasado(min));
}

function cabe(sala, inicio, duracion) {
  if (inicio + duracion > minFin()) return false;
  for (let m = inicio; m < inicio + duracion; m += intervalo()) {
    if (!libre(sala, m)) return false;
  }
  return true;
}

function finesPosibles(sala, inicio) {
  const fines = [];
  for (let m = inicio; m < minFin() && libre(sala, m); m += intervalo()) fines.push(m + intervalo());
  return fines;
}

function textoDuracion(min) {
  if (min < 60) return min + " min";
  const h = Math.floor(min / 60), r = min % 60;
  return h + " h" + (r ? " " + r : "");
}

// ---------- Formulario ----------

function reiniciarCombo(id, deshabilitar) {
  const combo = $(id);
  combo.innerHTML = '<option value="">Seleccione</option>';
  combo.disabled = !!deshabilitar;
  return combo;
}

function llenarCombo(combo, valores) {
  valores.forEach((v) => {
    const option = document.createElement("option");
    option.value = v;
    option.textContent = v;
    combo.appendChild(option);
  });
}

function actualizarComboSalas() {
  const anterior = $("sala").value;
  const combo = reiniciarCombo("sala", false);
  const nombres = estado.dia ? estado.dia.salas.map((s) => s.nombre) : [];
  llenarCombo(combo, nombres);
  combo.disabled = nombres.length === 0;
  if (nombres.includes(anterior)) combo.value = anterior;
  actualizarHorasInicio($("horaInicio").value);
}

// Horas de inicio = horarios libres de la sala (sin los ya pasados de hoy).
function actualizarHorasInicio(preferida) {
  const sala = $("sala").value;
  const anterior = preferida !== undefined ? preferida : $("horaInicio").value;
  const combo = reiniciarCombo("horaInicio", true);

  if (sala && estado.dia) {
    const horas = slots().filter((m) => libre(sala, m)).map(aHora);
    llenarCombo(combo, horas);
    combo.disabled = horas.length === 0;
    if (horas.includes(anterior)) combo.value = anterior;
  }
  actualizarHorasFin();
}

// Horas de fin posibles desde la hora de inicio (bloques libres seguidos).
function actualizarHorasFin(preferida) {
  const sala = $("sala").value;
  const inicio = $("horaInicio").value;
  const anterior = preferida || $("horaFin").value;
  const combo = reiniciarCombo("horaFin", true);

  if (sala && inicio) {
    const fines = finesPosibles(sala, aMin(inicio)).map(aHora);
    llenarCombo(combo, fines);
    combo.disabled = fines.length === 0;

    if (estado.duracion !== "otra") {
      const deseada = aHora(aMin(inicio) + estado.duracion);
      combo.value = fines.includes(deseada) ? deseada : "";
    } else if (fines.includes(anterior)) {
      combo.value = anterior;
    }
  }
  sincronizarSeleccion();
}

function limpiarHorasInicioYFin() {
  reiniciarCombo("horaInicio", true);
  reiniciarCombo("horaFin", true);
  sincronizarSeleccion();
}

function aplicarDuracion(d) {
  estado.duracion = d;
  $("campoHoraFin").hidden = d !== "otra";
  actualizarHorasFin();
}

// Elegir sala + hora desde la línea de tiempo, una ficha o una sugerencia.
function seleccionar(sala, inicio, irFormulario) {
  $("sala").value = sala;
  const hora = aHora(inicio);

  // Si la duración elegida no cabe, se prueba 1 h, 30 min y luego la más corta posible.
  if (estado.duracion === "otra" || !cabe(sala, inicio, estado.duracion)) {
    const alternativa = [60, 30, 90, 120].find((d) => cabe(sala, inicio, d));
    estado.duracion = alternativa || "otra";
    $("campoHoraFin").hidden = estado.duracion !== "otra";
  }

  actualizarHorasInicio(hora);
  if (estado.duracion === "otra") {
    const fines = finesPosibles(sala, inicio);
    if (fines.length) actualizarHorasFin(aHora(fines[0]));
  }

  if (irFormulario && MOVIL.matches) irAlFormulario();
}

// Refleja el formulario en la línea de tiempo, los chips, el botón y la barra móvil.
function sincronizarSeleccion() {
  renderChipsDuracion();

  const sala = $("sala").value, ini = $("horaInicio").value, fin = $("horaFin").value;
  const completa = sala && ini && fin;
  const resumen = completa ? sala + " · " + ini + " – " + fin : "";

  $("botonReservar").textContent = completa ? "Reservar " + resumen : "Reservar";
  $("textoTermina").textContent = completa && estado.duracion !== "otra"
    ? "Termina a las " + fin + " (" + textoDuracion(aMin(fin) - aMin(ini)) + ")" : "";
  if (ini && !fin && estado.duracion !== "otra") {
    $("textoTermina").textContent = "La sala no está libre " + textoDuracion(estado.duracion) +
      " desde las " + ini + ". Elige otra duración.";
  }

  $("barraMovilTexto").textContent = completa ? resumen : "Elige un horario libre";
  $("botonIrFormulario").textContent = completa ? "Completar" : "Nueva reserva";

  renderSeleccionEnLinea();
}

// ---------- Datos recordados (este navegador) ----------

function leerLocal(clave) {
  try { return localStorage.getItem(clave); } catch (e) { return null; }
}

function guardarLocal(clave, valor) {
  try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento */ }
}

function guardarDatosLocal() {
  guardarLocal("nombreReserva", $("nombre").value.trim());
  guardarLocal("apellidoReserva", $("apellido").value.trim());
  guardarLocal("empresaReserva", $("empresa").value);
  guardarLocal("unidadReserva", $("unidad").value);
}

function cargarDatosLocal() {
  const nombre = leerLocal("nombreReserva");
  const apellido = leerLocal("apellidoReserva");
  if (nombre) $("nombre").value = nombre;
  if (apellido) $("apellido").value = apellido;
}

async function restaurarEmpresaYUnidad() {
  const empresa = leerLocal("empresaReserva");
  const unidad = leerLocal("unidadReserva");
  const opciones = [...$("empresa").options].map((o) => o.value);
  if (empresa && opciones.includes(empresa)) {
    $("empresa").value = empresa;
    await alCambiarEmpresa();
    const unidades = [...$("unidad").options].map((o) => o.value);
    if (unidad && unidades.includes(unidad)) $("unidad").value = unidad;
  }
  mostrarCamposPersona(!personaCompleta());
}

function personaCompleta() {
  return ["nombre", "apellido", "empresa", "unidad"].every((id) => $(id).value.trim());
}

function mostrarCamposPersona(mostrar, enfocar) {
  $("camposPersona").hidden = !mostrar;
  $("resumenPersona").hidden = mostrar;
  if (!mostrar) {
    const nombre = $("nombre").value.trim(), apellido = $("apellido").value.trim();
    $("iniciales").textContent = ((nombre[0] || "") + (apellido[0] || "")).toUpperCase();
    $("resumenNombre").textContent = nombre + " " + apellido;
    $("resumenEmpresa").textContent = $("empresa").value + " · " + $("unidad").value;
  } else if (enfocar) {
    $("nombre").focus({ preventScroll: true });
  }
}

// ---------- Reservar ----------

// Todos los campos son obligatorios. Devuelve las etiquetas de los que faltan.
function obtenerCamposFaltantes() {
  return CAMPOS_OBLIGATORIOS
    .filter((c) => !$(c.id).value.trim())
    .map((c) => '"' + c.etiqueta + '"');
}

function mensajeCamposFaltantes(faltantes) {
  if (faltantes.length === 1) return "Falta completar " + faltantes[0] + ".";
  return "Falta completar: " + faltantes.slice(0, -1).join(", ") +
    " y " + faltantes[faltantes.length - 1] + ".";
}

async function reservar() {

  const faltantes = obtenerCamposFaltantes();

  if (faltantes.length) {
    if (["nombre", "apellido", "empresa", "unidad"].some((id) => !$(id).value.trim())) {
      mostrarCamposPersona(true);
    }
    $("modalAdvertenciaTexto").textContent = mensajeCamposFaltantes(faltantes);
    abrirModal("modalAdvertencia");
    return;
  }

  const errorCodigo = validarCodigo($("codigo").value);
  if (errorCodigo) {
    $("modalAdvertenciaTexto").textContent = errorCodigo;
    abrirModal("modalAdvertencia");
    return;
  }

  const boton = $("botonReservar");
  boton.disabled = true;
  boton.textContent = "Reservando...";

  try {
    const resultado = await rpc("crear_reserva_con_codigo", {
      p_codigo: normalizarCodigo($("codigo").value),
      p_nombre: $("nombre").value.trim(),
      p_apellido: $("apellido").value.trim(),
      p_empresa: $("empresa").value,
      p_unidad: $("unidad").value,
      p_sede: $("sede").value,
      p_fecha: $("fecha").value,
      p_sala: $("sala").value,
      p_hora_inicio: $("horaInicio").value,
      p_hora_fin: $("horaFin").value
    });

    if (!resultado || !resultado.ok) {
      mostrarMensaje("No se pudo reservar",
        (resultado && resultado.mensaje) || "Intente nuevamente.", "error");
      cargarDia();
      return;
    }

    mostrarModalConfirmacion(resultado);
    guardarDatosLocal();
    mostrarCamposPersona(false);
    $("codigo").value = "";
    limpiarHorasInicioYFin();
    cargarDia();

  } catch (e) {
    mostrarErrorGenerico(e);
  } finally {
    boton.disabled = false;
    sincronizarSeleccion();
  }
}

function mostrarModalConfirmacion(r) {
  const p = $("modalTexto");
  p.textContent = "";
  p.append(
    'Sala "' + r.sala + '" reservada', document.createElement("br"),
    'Día "' + formatearFechaVisual(r.fecha) + '"', document.createElement("br"),
    'A las "' + r.horaInicio + '" horas'
  );
  $("modalId").textContent = "ID de reserva: " + r.reservaId;
  abrirModal("modalConfirmacion");
}

function formatearFechaVisual(fechaISO) {
  const [anio, mes, dia] = fechaISO.split("-");
  return dia + "/" + mes + "/" + anio.slice(2);
}

// ---------- Pintar ----------

function renderTodo() {
  renderChipsSede();
  renderChipsFecha();
  renderResumenSedeFecha();
  renderLineaTiempo();
  renderSalas();
  renderSugerencias();
  sincronizarSeleccion();
}

function chip(texto, atributos, activo, extra) {
  return '<button type="button" class="chip' + (extra ? " " + extra : "") + '" ' + atributos +
    ' aria-pressed="' + (activo ? "true" : "false") + '">' + texto + "</button>";
}

function renderChipsSede() {
  const actual = $("sede").value;
  $("chipsSede").innerHTML = estado.sedes.map((s) =>
    chip(esc(s.replace(" - ", " · ")), 'data-sede="' + esc(s) + '"', s === actual)).join("");
}

const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DIAS_LARGOS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function diaSemana(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

function renderChipsFecha() {
  if (!estado.cfg.hoy) return;
  const actual = $("fecha").value;
  let html = "";
  for (let i = 0; i < DIAS_EN_CHIPS && i <= estado.cfg.maxDias; i++) {
    const iso = sumarDiasISO(estado.cfg.hoy, i);
    const etiqueta = i === 0 ? "Hoy" : i === 1 ? "Mañana" : DIAS_CORTOS[diaSemana(iso)];
    html += chip('<span class="chip-dia">' + etiqueta + '</span><span class="chip-num">' +
      Number(iso.slice(8)) + "</span>", 'data-fecha="' + iso + '"', iso === actual, "chip-fecha");
  }
  $("chipsFecha").innerHTML = html;
}

function textoFechaLarga(iso) {
  if (!iso) return "";
  const prefijo = iso === estado.cfg.hoy ? "Hoy, " : "";
  return prefijo + DIAS_LARGOS[diaSemana(iso)] + " " + formatearFechaVisual(iso);
}

function renderResumenSedeFecha() {
  const sede = $("sede").value;
  $("resumenSedeFecha").textContent = sede
    ? sede + " · " + textoFechaLarga($("fecha").value)
    : "Elige una sede arriba.";
}

function renderChipsDuracion() {
  const sala = $("sala").value;
  const inicio = $("horaInicio").value;
  const html = DURACIONES.map((d) => {
    const posible = !(sala && inicio) || cabe(sala, aMin(inicio), d);
    return '<button type="button" class="chip" data-duracion="' + d + '" aria-pressed="' +
      (estado.duracion === d) + '"' + (posible ? "" : " disabled") + ">" + textoDuracion(d) + "</button>";
  }).join("") + '<button type="button" class="chip" data-duracion="otra" aria-pressed="' +
    (estado.duracion === "otra") + '">Otra</button>';
  $("chipsDuracion").innerHTML = html;
}

// --- Línea de tiempo ---

function pct(min) {
  return ((min - minInicio()) / (minFin() - minInicio()) * 100).toFixed(3) + "%";
}

function renderLineaTiempo() {
  const cont = $("lineaTiempo");
  const d = estado.dia;

  if (!$("sede").value) {
    cont.innerHTML = '<p class="mensaje-estado">Elige una sede para ver la disponibilidad.</p>';
    return;
  }
  if (!d) {
    cont.innerHTML = '<p class="mensaje-estado">Cargando disponibilidad...</p>';
    return;
  }
  if (d.fisicas.length === 0) {
    cont.innerHTML = '<p class="mensaje-estado">No hay salas configuradas para esta sede.</p>';
    return;
  }

  let horas = "";
  for (let m = minInicio(); m < minFin(); m += 60) {
    horas += '<span class="lt-hora" style="left:' + pct(m) + '">' + aHora(m) + "</span>";
  }

  const ahora = ahoraMin();
  const lineaAhora = esHoy() && ahora >= minInicio() && ahora <= minFin()
    ? '<div class="lt-ahora" style="left:' + pct(ahora) + '" aria-hidden="true"></div>' : "";

  let filas = "";
  d.fisicas.forEach((sala) => {
    let celdas = "";
    slots().forEach((m) => {
      if (esPasado(m)) {
        celdas += '<span class="lt-celda pasada"></span>';
      } else if (libre(sala, m)) {
        const enPunto = m % 60 === 0;
        celdas += '<button type="button" class="lt-celda libre" data-sala="' + esc(sala) +
          '" data-hora="' + aHora(m) + '"' + (enPunto ? "" : ' tabindex="-1"') +
          ' aria-label="Reservar ' + esc(sala) + " a las " + aHora(m) + '" title="' + aHora(m) + '"></button>';
      } else {
        celdas += '<span class="lt-celda no-libre"></span>';
      }
    });

    const bloques = (d.reservas[sala] || []).map((r) => {
      const ini = aMin(r.inicio), fin = aMin(r.fin);
      const titulo = r.inicio + " – " + r.fin + " · " + (r.nombre || "") +
        (r.unidad ? " · " + r.unidad : "") + (r.empresa ? " · " + r.empresa : "");
      return '<div class="lt-bloque" style="left:' + pct(ini) + ";width:calc(" + pct(fin) + " - " + pct(ini) + ')" title="' + esc(titulo) + '">' +
        '<span class="lt-bloque-hora">' + esc(r.inicio) + "–" + esc(r.fin) + "</span>" +
        '<span class="lt-bloque-texto">' + esc(r.nombre || "") + (r.unidad ? " · " + esc(r.unidad) : "") + "</span>" +
        botonX(r, sala) + "</div>";
    }).join("");

    filas += '<div class="lt-fila"><div class="lt-nombre">' + esc(sala) + detalleSala(sala) + "</div>" +
      '<div class="lt-pista" data-pista="' + esc(sala) + '"><div class="lt-celdas">' + celdas + "</div>" +
      bloques + '<div class="lt-seleccion" hidden></div>' + lineaAhora + "</div></div>";
  });

  const desplazamiento = cont.scrollLeft;
  cont.innerHTML = '<div class="lt-interior"><div class="lt-cabecera"><div class="lt-nombre"></div>' +
    '<div class="lt-horas">' + horas + "</div></div>" + filas + "</div>";

  // En pantallas angostas la línea se desplaza: la primera vez que se
  // muestra un día de hoy, se lleva a la hora actual; después se respeta.
  const clave = $("sede").value + "|" + $("fecha").value;
  if (cont.scrollWidth > cont.clientWidth) {
    if (estado.desplazado !== clave && esHoy()) {
      const pista = cont.querySelector(".lt-pista");
      const nombre = cont.querySelector(".lt-fila .lt-nombre");
      if (pista && nombre) {
        const frac = (Math.max(ahora, minInicio()) - minInicio()) / (minFin() - minInicio());
        cont.scrollLeft = Math.max(0, frac * pista.offsetWidth - 24);
      }
    } else {
      cont.scrollLeft = desplazamiento;
    }
    estado.desplazado = clave;
  }

  renderSeleccionEnLinea();
}

function detalleSala(nombre) {
  const s = estado.dia && estado.dia.salas.find((x) => x.nombre === nombre);
  if (!s) return "";
  const partes = [];
  if (s.capacidad) partes.push(s.capacidad + " personas");
  equipos(s).forEach((e) => partes.push(e));
  return partes.length ? "<small>" + esc(partes.join(" · ")) + "</small>" : "";
}

function botonX(r, sala) {
  return '<button type="button" class="boton-x" title="Eliminar reserva" aria-label="Eliminar reserva de ' +
    esc(r.inicio) + " a " + esc(r.fin) + '"' +
    ' data-id="' + esc(r.id) + '"' +
    ' data-sala="' + esc(sala) + '"' +
    ' data-horario="' + esc(r.inicio) + " - " + esc(r.fin) + '"' +
    ' data-nombre="' + esc(r.nombre) + '"' +
    ' data-propia="' + (r.puedeCancelar ? "1" : "0") + '">&times;</button>';
}

// La selección se dibuja en la fila de la sala; si la sala une varias
// (ej. Sala Completa) se dibuja en todas las filas de la sede.
function renderSeleccionEnLinea() {
  const sala = $("sala").value, ini = $("horaInicio").value, fin = $("horaFin").value;
  const d = estado.dia;
  document.querySelectorAll(".lt-seleccion").forEach((el) => { el.hidden = true; });
  if (!d || !sala || !ini || !fin) return;

  const filas = d.fisicas.includes(sala) ? [sala] : d.fisicas;
  document.querySelectorAll(".lt-pista").forEach((pista) => {
    if (!filas.includes(pista.dataset.pista)) return;
    const el = pista.querySelector(".lt-seleccion");
    el.style.left = pct(aMin(ini));
    el.style.width = "calc(" + pct(aMin(fin)) + " - " + pct(aMin(ini)) + ")";
    el.title = sala + " · " + ini + " – " + fin;
    el.hidden = false;
  });
}

// --- Fichas de sala ---

function equipos(sala) {
  if (sala.equipamiento) {
    return sala.equipamiento.split(",").map((e) => e.trim()).filter(Boolean);
  }
  if (sala.tipo === "TV" || sala.tipo === "COMPLETA") return ["TV"];
  return [];
}

function tieneTV(sala) {
  return equipos(sala).some((e) => /^tv\b|televisor|pantalla/i.test(e));
}

// Estado de una sala para la fecha elegida.
function estadoSala(nombre) {
  const lista = slots();
  if (esHoy()) {
    const ahora = ahoraMin();
    const actual = lista.find((m) => m <= ahora && ahora < m + intervalo());
    if (actual === undefined || ahora >= minFin()) return { clase: "neutro", texto: "Fuera del horario de hoy", libreAhora: false };
    if (libre(nombre, actual)) {
      const finLibre = lista.find((m) => m > actual && !libre(nombre, m));
      return { clase: "libre", libreAhora: true,
        texto: finLibre === undefined ? "Libre el resto del día" : "Libre ahora · hasta las " + aHora(finLibre) };
    }
    const proximo = lista.find((m) => m > actual && libre(nombre, m));
    return { clase: "ocupada", libreAhora: false,
      texto: proximo === undefined ? "Ocupada el resto del día" : "Ocupada · libre desde las " + aHora(proximo) };
  }
  const libresDia = lista.filter((m) => libre(nombre, m)).length;
  if (libresDia === lista.length) return { clase: "libre", texto: "Libre todo el día", libreAhora: true };
  if (libresDia === 0) return { clase: "ocupada", texto: "Sin horarios libres", libreAhora: false };
  return { clase: "parcial", texto: textoDuracion(libresDia * intervalo()) + " libres este día", libreAhora: true };
}

function primerHueco(nombre, duracion) {
  return slots().find((m) => cabe(nombre, m, duracion));
}

function barraDia(nombre) {
  let html = "", inicio = null, tipo = null;
  const cerrar = (finMin) => {
    if (inicio === null) return;
    html += '<span class="barra-' + tipo + '" style="left:' + pct(inicio) + ";width:calc(" + pct(finMin) + " - " + pct(inicio) + ')"></span>';
    inicio = null;
  };
  slots().forEach((m) => {
    const t = esPasado(m) ? "pasado" : (libre(nombre, m) ? null : "ocupado");
    if (t !== tipo) { cerrar(m); if (t) inicio = m; tipo = t; }
  });
  cerrar(minFin());
  return '<div class="barra-dia" aria-hidden="true">' + html + "</div>";
}

function renderFiltros() {
  const d = estado.dia;
  if (!d) { $("filtrosSalas").innerHTML = ""; return; }
  const f = estado.filtros;
  let html = "";
  if (esHoy()) html += chip("Libres ahora", 'data-filtro="libresAhora"', f.libresAhora);
  if (d.salas.some(tieneTV)) html += chip("Con TV", 'data-filtro="tv"', f.tv);
  if (d.salas.some((s) => s.capacidad)) {
    [4, 6, 10].forEach((n) => { html += chip("Para " + n + " o más", 'data-filtro="cap" data-valor="' + n + '"', f.capMin === n); });
  }
  $("filtrosSalas").innerHTML = html;
}

function renderSalas() {
  const cont = $("fichasSalas");
  const d = estado.dia;
  if (!$("sede").value) { cont.innerHTML = '<p class="mensaje-estado">Elige una sede para ver las salas.</p>'; renderFiltros(); return; }
  if (!d) { cont.innerHTML = '<p class="mensaje-estado">Cargando salas...</p>'; renderFiltros(); return; }

  // Un filtro que no aplica a esta sede o fecha no debe esconder salas.
  if (!esHoy()) estado.filtros.libresAhora = false;
  if (!d.salas.some(tieneTV)) estado.filtros.tv = false;
  if (!d.salas.some((s) => s.capacidad)) estado.filtros.capMin = 0;
  renderFiltros();

  const f = estado.filtros;
  const dur = estado.duracion === "otra" ? 60 : estado.duracion;
  const lista = d.salas.map((s) => ({ s, e: estadoSala(s.nombre) })).filter(({ s, e }) =>
    (!f.libresAhora || e.libreAhora) && (!f.tv || tieneTV(s)) && (!f.capMin || (s.capacidad || 0) >= f.capMin));

  if (lista.length === 0) {
    cont.innerHTML = '<p class="mensaje-estado">Ninguna sala cumple los filtros elegidos.</p>';
    return;
  }

  cont.innerHTML = lista.map(({ s, e }) => {
    const hueco = primerHueco(s.nombre, dur);
    const chips = [];
    if (s.capacidad) chips.push(s.capacidad + " personas");
    equipos(s).forEach((x) => chips.push(x));
    let nota = "";
    if (s.tipo === "COMPLETA") {
      const otras = d.fisicas.filter((n) => n !== s.nombre);
      if (otras.length) nota = '<p class="ficha-nota">Une ' + esc(otras.join(" + ")) + "</p>";
    }
    const etiquetaBoton = hueco === undefined ? "Sin horarios libres"
      : (e.libreAhora && esHoy() && hueco <= ahoraMin() + intervalo() ? "Reservar ahora" : "Reservar a las " + aHora(hueco));
    return '<article class="ficha">' +
      '<div class="ficha-cabecera"><h3>' + esc(s.nombre) + '</h3><span class="estado estado-' + e.clase + '">' + esc(e.texto) + "</span></div>" +
      nota +
      (chips.length ? '<div class="ficha-chips">' + chips.map((c) => "<span>" + esc(c) + "</span>").join("") + "</div>" : "") +
      '<div class="ficha-dia"><span class="texto-suave">' + esc(estado.cfg.inicio) + " a " + esc(estado.cfg.fin) + "</span>" + barraDia(s.nombre) + "</div>" +
      '<div class="ficha-acciones">' +
        '<button type="button" class="boton-principal" data-accion="reservar" data-sala="' + esc(s.nombre) + '" data-min="' + (hueco === undefined ? "" : hueco) + '"' + (hueco === undefined ? " disabled" : "") + ">" + esc(etiquetaBoton) + "</button>" +
        '<button type="button" class="boton-secundario" data-accion="agenda">Ver agenda</button>' +
      "</div></article>";
  }).join("");
}

// --- Sugerencias ---

function renderSugerencias() {
  const d = estado.dia;
  const lista = $("listaSugerencias");
  const dur = estado.duracion === "otra" ? 60 : estado.duracion;

  if (!d) {
    $("subtituloSugerencias").textContent = $("sede").value ? "Cargando..." : "Elige una sede para ver sugerencias.";
    lista.innerHTML = "";
    return;
  }

  $("subtituloSugerencias").textContent = textoFechaLarga($("fecha").value) + " · " + textoDuracion(dur);

  const opciones = d.salas
    .map((s) => ({ sala: s.nombre, min: primerHueco(s.nombre, dur) }))
    .filter((o) => o.min !== undefined)
    .sort((a, b) => a.min - b.min)
    .slice(0, 4);

  lista.innerHTML = opciones.length
    ? opciones.map((o) => '<button type="button" class="sugerencia" data-sala="' + esc(o.sala) + '" data-min="' + o.min + '">' +
        '<span><strong>' + esc(o.sala) + "</strong><span>" + aHora(o.min) + " – " + aHora(o.min + dur) + "</span></span>" +
        '<span class="sugerencia-accion">Elegir</span></button>').join("")
    : '<p class="texto-suave">No hay horarios libres de ' + textoDuracion(dur) + " este día.</p>";
}

// ---------- Cancelar / eliminar ----------

async function cancelarReserva(reservaId) {

  const confirmado = await confirmarAccion("¿Desea cancelar esta reserva?");
  if (!confirmado) return;

  try {
    const resultado = await rpc("cancelar_reserva", { p_id: reservaId });

    mostrarMensaje(
      resultado.ok ? "Reserva cancelada" : "No se pudo cancelar",
      resultado.mensaje,
      resultado.ok ? "exito" : "error"
    );

    if (resultado.ok) cargarDia();
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

function normalizarCodigo(valor) {
  // Solo dígitos. Se trata como texto: el 0 inicial se conserva (0251 ≠ 251).
  return String(valor || "").replace(/\D/g, "").slice(0, 4);
}

// Devuelve un mensaje de error, o null si el código es válido.
function validarCodigo(valor) {
  if (!/^[0-9]{4}$/.test(String(valor || ""))) {
    return "El código debe tener 4 dígitos. Puede empezar con 0 (ejemplo: 0251).";
  }
  return null;
}

// "x" de una reserva: el administrador y quien la creó desde este
// navegador la eliminan con una confirmación; los demás, con su código.
function alPulsarEliminar(datos) {
  if (esAdminActual || datos.propia === "1") {
    cancelarReserva(datos.id);
    return;
  }
  const modal = $("modalAnular");
  modal.dataset.id = datos.id;
  $("anularResumen").textContent =
    datos.sala + " · " + datos.horario + (datos.nombre ? " · " + datos.nombre : "");
  $("anularCodigo").value = "";
  abrirModal("modalAnular");
}

async function anularConCodigo() {
  const id = $("modalAnular").dataset.id;
  const codigo = $("anularCodigo").value;

  const errorCodigo = validarCodigo(codigo);
  if (errorCodigo) {
    mostrarMensaje("Advertencia", errorCodigo, "advertencia");
    return;
  }

  const boton = $("botonAnularCodigo");
  boton.disabled = true;

  try {
    const resultado = await rpc("anular_con_codigo", {
      p_id: id,
      p_codigo: normalizarCodigo(codigo)
    });

    if (resultado && resultado.ok) cerrarModal("modalAnular");
    else $("anularCodigo").value = "";

    mostrarMensaje(
      resultado && resultado.ok ? "Reserva eliminada" : "No se pudo eliminar",
      (resultado && resultado.mensaje) || "Intente nuevamente.",
      resultado && resultado.ok ? "exito" : "error"
    );

    if (resultado && resultado.ok) cargarDia();
  } catch (e) {
    mostrarErrorGenerico(e);
  } finally {
    boton.disabled = false;
  }
}

// ---------- Modales ----------

function abrirModal(id) {
  $(id).style.display = "flex";
  const foco = $(id).querySelector("input, button");
  if (foco) foco.focus();
}

function cerrarModal(id) {
  $(id).style.display = "none";
}

// tipo: exito | error | advertencia | neutro
function mostrarMensaje(titulo, texto, tipo) {
  const h = $("modalMensajeTitulo");
  h.textContent = titulo;
  h.className = {
    error: "modal-titulo-error",
    advertencia: "modal-titulo-advertencia",
    neutro: "modal-titulo-neutro"
  }[tipo] || "";
  $("modalMensajeTexto").textContent = texto;
  abrirModal("modalMensaje");
}

function confirmarAccion(texto) {
  return new Promise((resolver) => {
    $("modalConfirmarTexto").textContent = texto;
    const si = $("botonConfirmarSi");
    const no = $("botonConfirmarNo");

    const terminar = (valor) => {
      si.removeEventListener("click", alSi);
      no.removeEventListener("click", alNo);
      cerrarModal("modalConfirmar");
      resolver(valor);
    };
    const alSi = () => terminar(true);
    const alNo = () => terminar(false);

    si.addEventListener("click", alSi);
    no.addEventListener("click", alNo);
    abrirModal("modalConfirmar");
    no.focus();
  });
}

function mostrarErrorGenerico(error) {
  console.error(error);
  mostrarMensaje("Error de conexión",
    "Ocurrió un problema al comunicarse con el servidor. Intente nuevamente.", "error");
}

function mostrarAvisoConfig(texto) {
  const aviso = $("avisoConfig");
  aviso.textContent = texto;
  aviso.style.display = "block";
}

// ---------- Utilidades ----------

function esc(valor) {
  return String(valor === null || valor === undefined ? "" : valor)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function texto(t) {
  const span = document.createElement("span");
  span.textContent = t;
  return span;
}

function botonEnlace(etiqueta, accion) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "enlace";
  b.textContent = etiqueta;
  b.addEventListener("click", accion);
  return b;
}

function hoyLocalISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function sumarDiasISO(iso, dias) {
  const [a, m, d] = (iso || hoyLocalISO()).split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}
