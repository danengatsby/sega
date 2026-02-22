export function localDateTime(daysOffset = 0): string {
  const date = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

export function fmtCurrency(value: number): string {
  return new Intl.NumberFormat('ro-RO', {
    style: 'currency',
    currency: 'RON',
    maximumFractionDigits: 2,
  }).format(value);
}

export function toNum(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}
