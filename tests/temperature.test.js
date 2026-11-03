import test from 'node:test';
import assert from 'node:assert/strict';
import { toDisplayTemperature, toFahrenheit, temperatureInputValue } from '../src/temperature.js';
import { analyzeForecast, isWithinCutoffs } from '../src/ranking.js';

test('temperature conversion handles freezing, boiling, and negative temperatures', () => {
  for (const [fahrenheit, celsius] of [[32, 0], [212, 100], [-40, -40], [86, 30]]) {
    assert.equal(toDisplayTemperature(fahrenheit, 'C'), celsius);
    assert.equal(toFahrenheit(celsius, 'C'), fahrenheit);
    assert.equal(toDisplayTemperature(fahrenheit, 'F'), fahrenheit);
    assert.equal(toFahrenheit(fahrenheit, 'F'), fahrenheit);
  }
  assert.equal(toDisplayTemperature(80), 80);
  assert.equal(toFahrenheit(80, 'unknown'), 80);
});

test('missing and invalid temperatures remain missing, never zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '', '32']) {
    for (const unit of ['C', 'F']) {
      assert.equal(toDisplayTemperature(value, unit), null);
      assert.equal(toFahrenheit(value, unit), null);
      assert.equal(temperatureInputValue(value, unit), '');
    }
  }
});

test('cutoff input text uses two decimals at most without trailing zeros', () => {
  assert.equal(temperatureInputValue(32, 'C'), '0');
  assert.equal(temperatureInputValue(80, 'C'), '26.67');
  assert.equal(temperatureInputValue(77, 'C'), '25');
  assert.equal(temperatureInputValue(32.9, 'C'), '0.5');
  assert.equal(temperatureInputValue(-40, 'C'), '-40');
  assert.equal(temperatureInputValue(80, 'F'), '80');
  assert.equal(temperatureInputValue(72.125, 'F'), '72.13');
});

const weather = (temperature) => ({ temperature, precipitationProbability: 10, aqi: 20, uv: 1 });

test('Celsius cutoffs remain inclusive at the matching Fahrenheit boundaries', () => {
  const cutoffs = { minTemperature: toFahrenheit(0, 'C'), maxTemperature: toFahrenheit(30, 'C') };
  for (const temperature of [32, 50, 86]) assert.equal(isWithinCutoffs(weather(temperature), cutoffs), true);
  for (const temperature of [31.99, 86.01]) assert.equal(isWithinCutoffs(weather(temperature), cutoffs), false);
  assert.equal(isWithinCutoffs(weather(null), cutoffs), false);
  assert.equal(isWithinCutoffs(weather(0), { minTemperature: toFahrenheit(null, 'C'), maxTemperature: toFahrenheit(0, 'C') }), true);
  assert.equal(isWithinCutoffs(weather(32.01), { minTemperature: null, maxTemperature: toFahrenheit(0, 'C') }), false);
});

test('equivalent Celsius and Fahrenheit cutoffs produce the same walk recommendations', () => {
  const date = '2026-11-03';
  const instant = (clock) => Date.parse(`${date}T${clock}:00Z`);
  const forecast = {
    location: { timezone: 'UTC' },
    days: [{ date, sunrise: instant('06:00'), sunset: instant('18:00') }],
    hours: [[8, 31], [9, 32], [10, 70], [18, 86], [19, 87]].map(([hour, temperature]) => ({
      ...weather(temperature), date, time: instant(`${String(hour).padStart(2, '0')}:00`),
    })),
  };
  const fahrenheit = analyzeForecast(forecast, instant('00:00'), undefined, { minTemperature: 32, maxTemperature: 86 });
  const celsius = analyzeForecast(forecast, instant('00:00'), undefined, { minTemperature: toFahrenheit(0, 'C'), maxTemperature: toFahrenheit(30, 'C') });
  assert.deepEqual(celsius, fahrenheit);
  assert.equal(celsius.bestDaylight.time, instant('09:00'));
  assert.equal(celsius.bestAfterDark.time, instant('18:00'));
});
