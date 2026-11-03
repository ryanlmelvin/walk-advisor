export function toDisplayTemperature(value, unit) {
  if (!Number.isFinite(value)) return null;
  return unit === 'C' ? (value - 32) * 5 / 9 : value;
}

export function toFahrenheit(value, unit) {
  if (!Number.isFinite(value)) return null;
  return unit === 'C' ? value * 9 / 5 + 32 : value;
}

export function temperatureInputValue(value, unit) {
  const displayed = toDisplayTemperature(value, unit);
  return displayed === null ? '' : String(Number(displayed.toFixed(2)));
}
