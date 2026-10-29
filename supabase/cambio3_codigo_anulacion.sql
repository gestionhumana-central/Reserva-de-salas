-- ==========================================================
-- CAMBIO 3 (2026-10-29): anular reservas con DNI o CE
-- ==========================================================
-- Quien reserva ingresa su DNI o CE. Se guarda solo cifrado
-- (bcrypt), nunca en texto. Con el ID de reserva + DNI/CE se
-- puede anular desde cualquier dispositivo.
-- El documento se trata como TEXTO: 05435296 y 5435296 son
-- distintos (se conservan los ceros iniciales).
-- Este script es aditivo: no modifica crear_reserva ni
-- cancelar_reserva.

begin;

-- 1. Tabla de códigos (bloqueada al público: RLS sin políticas)
create table if not exists public.reserva_codigos (
  reserva_id        text primary key references public.reservas(id) on delete cascade,
  codigo_hash       text not null,
  intentos_fallidos int  not null default 0,
  creado_en         timestamptz not null default now()
);
alter table public.reserva_codigos enable row level security;
revoke all on public.reserva_codigos from anon, authenticated;

-- 2. Normalizar documento: mayúsculas, sin espacios ni guiones.
--    NO quita ceros iniciales.
create or replace function public._normalizar_documento(p text)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'));
$$;

-- 3. Validar: DNI = 8 dígitos; CE = 9 a 12 caracteres alfanuméricos.
create or replace function public._documento_valido(p text)
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select p ~ '^[0-9]{8}$' or p ~ '^[0-9A-Z]{9,12}$';
$$;

-- 4. Crear reserva + guardar código, en una sola transacción.
--    Si no se puede guardar el código, la reserva tampoco se crea.
create or replace function public.crear_reserva_con_codigo(
  p_nombre text, p_apellido text, p_empresa text, p_unidad text,
  p_sede text, p_fecha text, p_sala text, p_hora_inicio text,
  p_hora_fin text, p_documento text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_doc text := _normalizar_documento(p_documento);
  v_res jsonb;
begin
  if v_doc ~ '^[0-9]{1,7}$' then
    return jsonb_build_object('ok', false, 'mensaje',
      'El DNI tiene 8 dígitos. Si tu DNI empieza con 0, inclúyelo (ejemplo: 05435296).');
  end if;

  if not _documento_valido(v_doc) then
    return jsonb_build_object('ok', false, 'mensaje',
      'Ingresa un DNI (8 dígitos) o CE válido.');
  end if;

  v_res := crear_reserva(p_nombre, p_apellido, p_empresa, p_unidad, p_sede,
                         p_fecha, p_sala, p_hora_inicio, p_hora_fin);

  if coalesce((v_res ->> 'ok')::boolean, false) then
    insert into reserva_codigos (reserva_id, codigo_hash)
    values (v_res ->> 'reservaId', crypt(v_doc, gen_salt('bf')));
  end if;

  return v_res;
end;
$$;

-- 5. Anular con ID de reserva + DNI/CE (máx. 5 intentos fallidos)
create or replace function public.anular_con_codigo(p_id text, p_documento text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_id  text := upper(trim(coalesce(p_id, '')));
  v_doc text := _normalizar_documento(p_documento);
  v_r   reservas%rowtype;
  v_c   reserva_codigos%rowtype;
  c_max constant int := 5;
begin
  select * into v_r from reservas where id = v_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'mensaje',
      'No se encontró la reserva. Revisa el ID (ejemplo: RSV-20261029-001).');
  end if;

  if v_r.estado = 'CANCELADA' then
    return jsonb_build_object('ok', false, 'mensaje', 'Esta reserva ya se encuentra cancelada.');
  end if;

  if v_r.fecha < _hoy_local() then
    return jsonb_build_object('ok', false, 'mensaje', 'No se pueden anular reservas de fechas pasadas.');
  end if;

  select * into v_c from reserva_codigos where reserva_id = v_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'mensaje',
      'Esta reserva no tiene DNI o CE registrado. Solo puede anularse desde el navegador donde se creó o por el administrador.');
  end if;

  if v_c.intentos_fallidos >= c_max then
    return jsonb_build_object('ok', false, 'mensaje',
      'Se superó el número de intentos para esta reserva. Contacta al administrador.');
  end if;

  if v_doc = '' or crypt(v_doc, v_c.codigo_hash) <> v_c.codigo_hash then
    update reserva_codigos set intentos_fallidos = intentos_fallidos + 1 where reserva_id = v_id;
    return jsonb_build_object('ok', false, 'mensaje',
      'El DNI o CE no coincide con el de la reserva. Recuerda incluir los ceros iniciales. Intentos restantes: '
      || greatest(c_max - v_c.intentos_fallidos - 1, 0) || '.');
  end if;

  update reservas set estado = 'CANCELADA' where id = v_id;
  update reserva_ocupaciones set activa = false where reserva_id = v_id;

  insert into auditoria (accion, reserva_id, usuario)
  values ('CANCELACION_CON_DNI', v_id, _usuario_auditoria());

  return jsonb_build_object('ok', true, 'mensaje', 'Reserva cancelada correctamente.');
end;
$$;

-- 6. Permisos: solo visitantes con sesión (anónima o con correo)
revoke all on function public._normalizar_documento(text) from public, anon, authenticated;
revoke all on function public._documento_valido(text) from public, anon, authenticated;
revoke all on function public.crear_reserva_con_codigo(text,text,text,text,text,text,text,text,text,text) from public, anon;
revoke all on function public.anular_con_codigo(text,text) from public, anon;
grant execute on function public.crear_reserva_con_codigo(text,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.anular_con_codigo(text,text) to authenticated;

commit;

-- 7. PASO FINAL (ejecutar SOLO cuando la nueva web esté publicada):
--    obliga a que toda reserva nueva pase por el DNI/CE.
-- revoke execute on function public.crear_reserva(text,text,text,text,text,text,text,text,text) from authenticated;
