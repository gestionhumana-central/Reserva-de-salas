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
  { id: "horaFin", etiqueta: "Hora Fin" }
];

const $ = (id) => document.getElementById(id);

let sb = null;
let sesionActual = null;

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
    mostrarAvisoConfig("Falta configurar la conexión a Supabase en public/js/config.js.");
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
  $("botonEnviarEnlace").addEventListener("click", enviarEnlaceAcceso);

  // Botones "Cerrar"/"Volver" de todos los modales.
  document.querySelectorAll("[data-cerrar]").forEach((b) =>
    b.addEventListener("click", () => cerrarModal(b.dataset.cerrar)));

  // Cancelar reserva (delegación: las tarjetas se regeneran).
  $("calendarioVisual").addEventListener("click", (ev) => {
    const boton = ev.target.closest(".boton-cancelar");
    if (boton) cancelarReserva(boton.dataset.id);
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

  if (!usuario || usuario.is_anonymous) {
    barra.append(
      texto("Estás reservando como invitado. Solo desde este navegador podrás cancelar tus reservas."),
      botonEnlace("Iniciar sesión con correo", () => abrirModal("modalLogin"))
    );
    return;
  }

  let esAdmin = false;
  try {
    esAdmin = await rpc("soy_admin");
  } catch (e) {
    console.error(e);
  }

  barra.append(
    texto("Sesión iniciada: " + (usuario.email || "") + (esAdmin ? " (administrador)" : "")),
    botonEnlace("Cerrar sesión", cerrarSesion)
  );
}

async function enviarEnlaceAcceso() {
  const correo = $("loginCorreo").value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    mostrarMensaje("Advertencia", "Ingrese un correo válido.", "advertencia");
    return;
  }

  const boton = $("botonEnviarEnlace");
  boton.disabled = true;

  const { error } = await sb.auth.signInWithOtp({
    email: correo,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });

  boton.disabled = false;
  cerrarModal("modalLogin");

  if (error) {
    console.error(error);
    mostrarMensaje("No se pudo enviar el enlace",
      "Espere unos minutos e intente nuevamente.", "error");
    return;
  }

  mostrarMensaje("Revise su correo",
    "Le enviamos un enlace de acceso. Ábralo en este mismo navegador.", "neutro");
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

function obtenerPrimerCampoFaltante() {
  const faltante = CAMPOS_OBLIGATORIOS.find((c) => !$(c.id).value.trim());
  return faltante ? faltante.etiqueta : null;
}

async function reservar() {

  const campoFaltante = obtenerPrimerCampoFaltante();

  if (campoFaltante) {
    $("modalAdvertenciaTexto").textContent = 'Falta completar "' + campoFaltante + '".';
    abrirModal("modalAdvertencia");
    return;
  }

  const boton = $("botonReservar");
  boton.disabled = true;
  boton.textContent = "Reservando...";

  try {
    const resultado = await rpc("crear_reserva", {
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
  // Se conservan Nombre y Apellido; se limpian Fecha, Sala y Horas.
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
          '<div class="reserva-hora">🔴 ' + esc(r.inicio) + " - " + esc(r.fin) + "</div>" +
          '<div class="reserva-nombre">' + esc(r.nombre) + "</div>" +
          '<div class="reserva-unidad">' + esc(r.unidad) + "</div>" +
          (r.empresa ? '<div class="reserva-empresa">' + esc(r.empresa) + "</div>" : "");

      if (r.puedeCancelar) {
        html +=
          '<div style="margin-top:10px;">' +
            '<button type="button" class="boton-cancelar" data-id="' + esc(r.id) + '">Cancelar</button>' +
          "</div>";
      }

      html += "</div>";
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
