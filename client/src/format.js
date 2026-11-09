export function fmtPrice(v, currency) {
  if (v == null || Number.isNaN(v)) return '—';
  const digits = Math.abs(v) < 1 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    ...(currency ? { style: 'currency', currency } : {}),
  }).format(v);
}

export function fmtChange(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + fmtPrice(Math.abs(v));
}

export function fmtPct(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
}

export function fmtVolume(v) {
  if (v == null) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(v);
}

export function fmtTime(sec, timeZone, withTime = true) {
  if (!sec) return '';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timeZone || undefined,
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  }).format(new Date(sec * 1000));
}
