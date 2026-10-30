-- ==========================================================
-- CAMBIO 3 (2026-10-30): anular reservas con código de 4 dígitos
-- ==========================================================
-- Quien reserva elige un código de 4 dígitos. Se guarda solo
-- cifrado (bcrypt), nunca en texto. Con el código se puede
-- eliminar la reserva desde cualquier dispositivo (botón "x"
-- de la reserva en "Estado de las Salas").
-- El código se trata como TEXTO: 0251 es un código válido y
-- distinto de 251 (que se rechaza por no tener 4 dígitos).
-- Este script es aditivo: no modifica crear_reserva ni
-- cancelar_reserva.

begin;

-- 0. Versión anterior (DNI/CE) — se reemplaza por esta
drop function if exists public.crear_reserva_con_codigo(text,text,text,text,text,text,text,text,text,text);
drop function if exists public.anular_con_codigo(text,text);
drop function if exists public._normalizar_documento(text);
drop function if exists public._documento_valido(text);

-- 1. Tabla de códigos (bloqueada al público: RLS sin políticas)
create table if not exists public.reserva_codigos (
  reserva_id        text primary key references public.reservas(id) on delete cascade,
  codigo_hash       text not null,
  intentos_fallidos int  not null default 0,
  creado_en         timestamptz not null default now()
);
alter table public.reserva_codigos enable row level security;
revoke all on public.reserva_codigos from anon, authenticated;

-- 2. Crear reserva + guardar código, en una sola transacción.
--    Si no se puede guardar el código, la reserva tampoco se crea.
create or replace function public.crear_reserva_con_codigo(
  p_nombre text, p_apellido text, p_empresa text, p_unidad text,
  p_sede text, p_fecha text, p_sala text, p_hora_inicio text,
  p_hora_fin text, p_codigo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_cod text := trim(coalesce(p_codigo, ''));
  v_res jsonb;
begin
  if v_cod !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'mensaje',
      'El código debe tener 4 dígitos. Puede empezar con 0 (ejemplo: 0251).');
  end if;

  v_res := crear_reserva(p_nombre, p_apellido, p_empresa, p_unidad, p_sede,
                         p_fecha, p_sala, p_hora_inicio, p_hora_fin);

  if coalesce((v_res ->> 'ok')::boolean, false) then
    insert into reserva_codigos (reserva_id, codigo_hash)
    values (v_res ->> 'reservaId', crypt(v_cod, gen_salt('bf')));
  end if;

  return v_res;
end;
$$;

-- 3. Eliminar con código (máx. 5 intentos fallidos por reserva)
create or replace function public.anular_con_codigo(p_id text, p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare
  v_id  text := upper(trim(coalesce(p_id, '')));
  v_cod text := trim(coalesce(p_codigo, ''));
  v_r   reservas%rowtype;
  v_c   reserva_codigos%rowtype;
  c_max constant int := 5;
begin
  select * into v_r from reservas where id = v_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'mensaje', 'No se encontró la reserva.');
  end if;

  if v_r.estado = 'CANCELADA' then
    return jsonb_build_object('ok', false, 'mensaje', 'Esta reserva ya se encuentra cancelada.');
  end if;

  if v_r.fecha < _hoy_local() then
    return jsonb_build_object('ok', false, 'mensaje', 'No se pueden eliminar reservas de fechas pasadas.');
  end if;

  select * into v_c from reserva_codigos where reserva_id = v_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'mensaje',
      'Esta reserva no tiene código registrado. Solo puede eliminarla el administrador.');
  end if;

  if v_c.intentos_fallidos >= c_max then
    return jsonb_build_object('ok', false, 'mensaje',
      'Se superó el número de intentos para esta reserva. Contacta al administrador.');
  end if;

  if v_cod !~ '^[0-9]{4}$' or crypt(v_cod, v_c.codigo_hash) <> v_c.codigo_hash then
    update reserva_codigos set intentos_fallidos = intentos_fallidos + 1 where reserva_id = v_id;
    return jsonb_build_object('ok', false, 'mensaje',
      'El código no es correcto. Intentos restantes: '
      || greatest(c_max - v_c.intentos_fallidos - 1, 0) || '.');
  end if;

  update reservas set estado = 'CANCELADA' where id = v_id;
  update reserva_ocupaciones set activa = false where reserva_id = v_id;

  insert into auditoria (accion, reserva_id, usuario)
  values ('CANCELACION_CON_CODIGO', v_id, _usuario_auditoria());

  return jsonb_build_object('ok', true, 'mensaje', 'Reserva eliminada correctamente.');
end;
$$;

-- 4. Permisos: solo visitantes con sesión (anónima o con correo)
revoke all on function public.crear_reserva_con_codigo(text,text,text,text,text,text,text,text,text,text) from public, anon;
revoke all on function public.anular_con_codigo(text,text) from public, anon;
grant execute on function public.crear_reserva_con_codigo(text,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.anular_con_codigo(text,text) to authenticated;

commit;

-- 5. PASO FINAL (ejecutar SOLO cuando la nueva web esté publicada):
--    obliga a que toda reserva nueva tenga código.
-- revoke execute on function public.crear_reserva(text,text,text,text,text,text,text,text,text) from authenticated;
