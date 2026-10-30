-- ==========================================================
-- CAMBIO 4 (2026-10-30): borrado automático de reservas antiguas
-- ==========================================================
-- Cada día a las 03:00 (hora de Lima) se eliminan las reservas
-- cuya FECHA DE LA RESERVA (columna "fecha", el día en que se usa
-- la sala) tiene más de un mes de antigüedad.
-- NO se usa la fecha en que se hizo la reserva ("creado_en").
--   Ej.: hoy 30/10/2026 → se borran las reservas de fecha
--        29/09/2026 o anterior. Una reserva hecha el 30/09
--        para usar la sala el 30/10 NO se borra.
-- Al borrar una reserva se borran también (en cascada) su
-- ocupación de salas y su código de seguridad.

begin;

create extension if not exists pg_cron;

create or replace function public.purgar_reservas_antiguas(p_simular boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_corte date := (_hoy_local() - interval '1 month')::date;
  v_ids   text[];
  v_imp   int := 0;
  v_aud   int := 0;
begin
  select coalesce(array_agg(id), '{}') into v_ids
  from reservas
  where fecha < v_corte;

  if p_simular then
    return jsonb_build_object(
      'simulacion', true,
      'corte', v_corte,
      'reservas_a_borrar', coalesce(array_length(v_ids, 1), 0),
      'fecha_mas_reciente_a_borrar', (select max(fecha) from reservas where fecha < v_corte),
      'fecha_mas_antigua_que_queda', (select min(fecha) from reservas where fecha >= v_corte));
  end if;

  delete from auditoria where reserva_id = any(v_ids);
  get diagnostics v_aud = row_count;

  -- reserva_ocupaciones y reserva_codigos se borran en cascada
  delete from reservas where id = any(v_ids);

  -- Copia temporal de la migración desde Google Sheets
  delete from reservas_importadas
  where fecha ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and fecha::date < v_corte;
  get diagnostics v_imp = row_count;

  return jsonb_build_object(
    'corte', v_corte,
    'reservas_borradas', coalesce(array_length(v_ids, 1), 0),
    'auditoria_borrada', v_aud,
    'importadas_borradas', v_imp);
end;
$$;

revoke all on function public.purgar_reservas_antiguas(boolean) from public, anon, authenticated;

-- 03:00 Lima = 08:00 UTC (pg_cron trabaja en UTC; Perú no tiene horario de verano)
select cron.unschedule(jobid) from cron.job where jobname = 'purgar-reservas-antiguas';
select cron.schedule('purgar-reservas-antiguas', '0 8 * * *', 'select public.purgar_reservas_antiguas()');

commit;
