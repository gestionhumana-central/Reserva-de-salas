-- ==========================================================
-- CAMBIO 5 (2026-10-30): datos para la nueva interfaz
-- ==========================================================
-- Aditivo: no cambia ninguna función existente.
-- 1. Columnas opcionales en "salas" para las fichas de sala:
--      capacidad     → número de personas (ej. 8)
--      equipamiento  → texto separado por comas (ej. "TV, Pizarra")
--    Se llenan desde Supabase → Table Editor → salas.
-- 2. obtener_salas_detalle(sede): las salas reservables con esos datos.
-- 3. obtener_config_horario(): horario de atención, intervalo,
--    días máximos y la fecha/hora actual de Lima (del servidor).

begin;

alter table public.salas add column if not exists capacidad int;
alter table public.salas add column if not exists equipamiento text;

create or replace function public.obtener_salas_detalle(p_sede text)
returns table (nombre text, tipo text, capacidad int, equipamiento text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.nombre, s.tipo, d.capacidad, d.equipamiento
  from obtener_salas(p_sede) with ordinality as s(nombre, tipo, n)
  left join salas d on d.sede = p_sede and d.nombre = s.nombre
  order by s.n;
$$;

create or replace function public.obtener_config_horario()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'inicio',    _cfg('HORA_INICIO', '08:00'),
    'fin',       _cfg('HORA_FIN', '20:00'),
    'intervalo', _cfg('INTERVALO_MINUTOS', '15')::int,
    'maxDias',   _cfg('MAX_DIAS_RESERVA', '30')::int,
    'hoy',       _hoy_local(),
    'ahora',     to_char(now() at time zone _cfg('ZONA_HORARIA', 'America/Lima'), 'HH24:MI'));
$$;

revoke all on function public.obtener_salas_detalle(text) from public;
revoke all on function public.obtener_config_horario() from public;
grant execute on function public.obtener_salas_detalle(text) to anon, authenticated;
grant execute on function public.obtener_config_horario() to anon, authenticated;

commit;
