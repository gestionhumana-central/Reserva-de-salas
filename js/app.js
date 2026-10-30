"use strict";

// ==========================================================
// RESERVA DE SALAS — Frontend (Supabase)
// ==========================================================
// El navegador solo muestra datos y envía solicitudes. Toda la
// validación (disponibilidad, sede→sala, empresa→unidad, 30 días,
// permisos de cancelación) se repite en el servidor.

const ZONA_HORARIA = "America/Lima";
const MAX_DIAS_RESERVA = 30; // solo para limitar el calendario; el servidor valida

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

  cargarDatosLocal();
  configurarRangoFecha();
  registrarEventos();

  try {
    await asegurarSesion();
    await actualizarBarraSesion();
    await Promise.all([cargarEmpresas(), cargarSedes()]);
  } catch (e) {
    mostrarErrorGenerico(e);
  }

  sb.auth.onAuthStateChange((_evento, session) => {
    sesionActual = session;
    // Fuera del callback, para no bloquear al cliente de Supabase.
    setTimeout(() => {
      actualizarBarraSesion();
      cargarCalendarioVisual();
    }, 0);
  });
}

function registrarEventos() {
  $("empresa").addEventListener("change", alCambiarEmpresa);
  $("sede").addEventListener("change", alCambiarSede);
  $("fecha").addEventListener("change", () => {
    actualizarHorasInicio();
    cargarCalendarioVisual();
  });
  $("sala").addEventListener("change", actualizarHorasInicio);
  $("horaInicio").addEventListener("change", actualizarHorasFin);
  $("botonReservar").addEventListener("click", reservar);
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

  // "x" de cada reserva (delegación: las tarjetas se regeneran).
  $("calendarioVisual").addEventListener("click", (ev) => {
    const boton = ev.target.closest(".boton-x");
    if (boton) alPulsarEliminar(boton.dataset);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    document.querySelectorAll(".modal-overlay").forEach((m) => {
      if (m.style.display !== "none" && m.id !== "modalConfirmar") m.style.display = "none";
    });
  });
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

  barra.innerHTML = "";
  esAdminActual = false;

  if (!usuario || usuario.is_anonymous) {
    barra.append(
      texto("Para eliminar una reserva, haz clic en su \"x\" y coloca tu código de 4 dígitos.")
    );
    return;
  }

  try {
    esAdminActual = !!(await rpc("soy_admin"));
  } catch (e) {
    console.error(e);
  }

  barra.append(
    texto("Sesión iniciada: " + (usuario.email || "") + (esAdminActual ? " (administrador)" : "")),
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
  const error = (texto) => { $("loginError").textContent = texto; };

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
    cargarCalendarioVisual();
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
  cargarCalendarioVisual();
}

// ---------- Llamadas al servidor ----------

async function rpc(nombre, params) {
  const { data, error } = await sb.rpc(nombre, params || {});
  if (error) throw error;
  return data;
}

// ---------- Combos ----------

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

async function cargarEmpresas() {
  const empresas = await rpc("obtener_empresas");
  llenarCombo(reiniciarCombo("empresa", false), empresas || []);
}

async function cargarSedes() {
  const sedes = await rpc("obtener_sedes");
  llenarCombo(reiniciarCombo("sede", false), sedes || []);
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

// Sede → Sala (+ Estado de las Salas)
async function alCambiarSede() {
  const sede = $("sede").value;
  const combo = reiniciarCombo("sala", true);
  const t = nuevoTurno("sala");

  limpiarHorasInicioYFin();
  cargarCalendarioVisual();

  if (!sede) return;

  try {
    const salas = await rpc("obtener_salas", { p_sede: sede });
    if (!turnoVigente("sala", t)) return;
    llenarCombo(combo, (salas || []).map((s) => s.nombre));
    combo.disabled = false;
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

// Fecha + Sede + Sala → Horas de inicio
async function actualizarHorasInicio() {
  const fecha = $("fecha").value;
  const sede = $("sede").value;
  const sala = $("sala").value;

  const combo = reiniciarCombo("horaInicio", true);
  reiniciarCombo("horaFin", true);
  const t = nuevoTurno("horaInicio");
  nuevoTurno("horaFin");

  if (!fecha || !sede || !sala) return;

  try {
    const horas = await rpc("obtener_horas_inicio", { p_fecha: fecha, p_sede: sede, p_sala: sala });
    if (!turnoVigente("horaInicio", t)) return;
    llenarCombo(combo, horas || []);
    combo.disabled = false;
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

// Hora de inicio → Horas de fin
async function actualizarHorasFin() {
  const fecha = $("fecha").value;
  const sede = $("sede").value;
  const sala = $("sala").value;
  const horaInicio = $("horaInicio").value;

  const combo = reiniciarCombo("horaFin", true);
  const t = nuevoTurno("horaFin");

  if (!horaInicio) return;

  try {
    const horas = await rpc("obtener_horas_fin", {
      p_fecha: fecha, p_sede: sede, p_sala: sala, p_hora_inicio: horaInicio
    });
    if (!turnoVigente("horaFin", t)) return;
    llenarCombo(combo, horas || []);
    combo.disabled = false;
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

function limpiarHorasInicioYFin() {
  reiniciarCombo("horaInicio", true);
  reiniciarCombo("horaFin", true);
  nuevoTurno("horaInicio");
  nuevoTurno("horaFin");
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
      actualizarHorasInicio();
      cargarCalendarioVisual();
      return;
    }

    mostrarModalConfirmacion(resultado);
    guardarDatosLocal();
    limpiarFormularioTrasReserva();
    cargarCalendarioVisual();

  } catch (e) {
    mostrarErrorGenerico(e);
  } finally {
    boton.disabled = false;
    boton.textContent = "Reservar";
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

// ---------- localStorage (Nombre y Apellido) ----------

function guardarDatosLocal() {
  try {
    localStorage.setItem("nombreReserva", $("nombre").value);
    localStorage.setItem("apellidoReserva", $("apellido").value);
  } catch (e) { /* navegador sin almacenamiento: se ignora */ }
}

function cargarDatosLocal() {
  try {
    const nombre = localStorage.getItem("nombreReserva");
    const apellido = localStorage.getItem("apellidoReserva");
    if (nombre) $("nombre").value = nombre;
    if (apellido) $("apellido").value = apellido;
  } catch (e) { /* se ignora */ }
}

function limpiarFormularioTrasReserva() {
  // Se conservan Nombre y Apellido; se limpian Código, Fecha, Sala y Horas.
  // El código nunca se guarda en el navegador (puede ser una PC compartida).
  $("codigo").value = "";
  $("fecha").value = "";
  $("sala").selectedIndex = 0;
  limpiarHorasInicioYFin();
}

// ---------- Estado de las Salas ----------

async function cargarCalendarioVisual() {

  if (!sb) return;

  const fecha = $("fecha").value;
  const sede = $("sede").value;
  const contenedor = $("calendarioVisual");
  const t = nuevoTurno("calendario");

  if (!sede || !fecha) {
    contenedor.className = "mensaje-estado";
    contenedor.textContent = "Seleccione una sede y una fecha para ver la disponibilidad.";
    return;
  }

  contenedor.className = "mensaje-estado";
  contenedor.textContent = "Cargando disponibilidad...";

  try {
    const data = await rpc("obtener_calendario", { p_fecha: fecha, p_sede: sede });
    if (!turnoVigente("calendario", t)) return;

    const salas = (data && data.salas) || [];
    const reservasPorSala = (data && data.reservasPorSala) || {};

    if (salas.length === 0) {
      contenedor.className = "mensaje-estado";
      contenedor.textContent = "No hay salas configuradas para esta sede.";
      return;
    }

    const columnas = salas.length === 1 ? "" : " cols-2";
    let html = '<div class="calendario-grid' + columnas + '">';
    salas.forEach((nombreSala) => {
      html += construirSala(nombreSala, reservasPorSala[nombreSala] || []);
    });
    html += "</div>";

    contenedor.className = "";
    contenedor.innerHTML = html;

  } catch (e) {
    if (!turnoVigente("calendario", t)) return;
    contenedor.className = "mensaje-estado";
    contenedor.textContent = "No se pudo cargar la disponibilidad. Intente nuevamente.";
    console.error(e);
  }
}

function construirSala(titulo, reservas) {

  let html = '<div class="sala-card">';
  html += '<div class="sala-titulo">' + esc(titulo) + "</div>";

  if (reservas.length === 0) {
    html += '<div class="disponible">🟢 Disponible</div>';
  } else {
    reservas.forEach((r) => {
      html +=
        '<div class="reserva-bloque">' +
          '<button type="button" class="boton-x" title="Eliminar reserva" aria-label="Eliminar reserva de ' +
            esc(r.inicio) + " a " + esc(r.fin) + '"' +
            ' data-id="' + esc(r.id) + '"' +
            ' data-sala="' + esc(titulo) + '"' +
            ' data-horario="' + esc(r.inicio) + " - " + esc(r.fin) + '"' +
            ' data-nombre="' + esc(r.nombre) + '"' +
            ' data-propia="' + (r.puedeCancelar ? "1" : "0") + '">&times;</button>' +
          '<div class="reserva-hora">🔴 ' + esc(r.inicio) + " - " + esc(r.fin) + "</div>" +
          '<div class="reserva-nombre">' + esc(r.nombre) + "</div>" +
          '<div class="reserva-unidad">' + esc(r.unidad) + "</div>" +
          (r.empresa ? '<div class="reserva-empresa">' + esc(r.empresa) + "</div>" : "") +
        "</div>";
    });
  }

  html += "</div>";
  return html;
}

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

    if (resultado.ok) {
      cargarCalendarioVisual();
      actualizarHorasInicio();
    }
  } catch (e) {
    mostrarErrorGenerico(e);
  }
}

// ---------- Eliminar con código de 4 dígitos ----------

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

    if (resultado && resultado.ok) {
      cargarCalendarioVisual();
      actualizarHorasInicio();
    }
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
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

function configurarRangoFecha() {
  const hoy = hoyLocalISO();
  $("fecha").min = hoy;
  $("fecha").max = sumarDiasISO(hoy, MAX_DIAS_RESERVA);
}
