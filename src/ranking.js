const WEATHER_METRICS = ['temperature', 'uv', 'precipitationProbability', 'precipitation'];
const ALL_METRICS = [...WEATHER_METRICS, 'aqi'];
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const hasMetrics = (hour, metrics) => metrics.every((metric) => isNumber(hour[metric]));

function validSunTimes(day) {
  return isNumber(day.sunrise) && isNumber(day.sunset) && day.sunset > day.sunrise;
}

function percentileMap(hours, metric) {
  const values = hours.map((hour) => hour[metric]).sort((left, right) => left - right);
  const ranks = new Map();
  if (!values.length) return ranks;
  if (values[0] === values.at(-1)) return new Map([[values[0], 0]]);
  for (let first = 0; first < values.length;) {
    let last = first;
    while (last + 1 < values.length && values[last + 1] === values[first]) last++;
    ranks.set(values[first], ((first + last) / 2) / (values.length - 1));
    first = last + 1;
  }
  return ranks;
}

function scoreHours(hours, includeAir) {
  const metrics = includeAir ? ALL_METRICS : WEATHER_METRICS;
  const ranks = Object.fromEntries(metrics.map((metric) => [metric, percentileMap(hours, metric)]));
  return new Map(hours.map((hour) => {
    const precipitation = (ranks.precipitationProbability.get(hour.precipitationProbability)
      + ranks.precipitation.get(hour.precipitation)) / 2;
    const total = ranks.temperature.get(hour.temperature) + ranks.uv.get(hour.uv) + precipitation
      + (includeAir ? ranks.aqi.get(hour.aqi) : 0);
    return [hour.time, { ...hour, rank: total / (includeAir ? 4 : 3) }];
  }));
}

function earliestLowest(hours) {
  return hours.reduce((best, hour) => !best || hour.rank < best.rank - 1e-12
    || (Math.abs(hour.rank - best.rank) <= 1e-12 && hour.time < best.time) ? hour : best, null);
}

function pickPeriod(hours, completeScores, weatherScores, missingReason) {
  const complete = hours.map((hour) => completeScores.get(hour.time)).filter(Boolean);
  if (complete.length) return { best: earliestLowest(complete), complete: true, reason: null };
  const weather = hours.map((hour) => weatherScores.get(hour.time)).filter(Boolean);
  if (weather.length) return {
    best: earliestLowest(weather), complete: false,
    reason: 'AQI unavailable; weather-only suggestion.',
  };
  return {
    best: null, complete: false,
    reason: hours.length ? 'Not enough forecast data to compare these hours.' : missingReason,
  };
}

/**
 * Compare upcoming hourly points during daylight and from sunset to midnight.
 * Four factors have equal weight: temperature, UV, AQI, and precipitation
 * (the average of probability and amount). Lower percentile is better; ties
 * choose the earliest hour. There are intentionally no temperature bounds yet.
 * All complete hours share one reference population, so daily and weekly picks
 * agree. Weather-only picks share a separate population and are never promoted
 * to the all-factor weekly recommendations. Missing values are never zero.
 * Individual metric minima use the same eligible upcoming hours, including
 * hours with a missing different metric; each result includes every tied hour.
 */
export function analyzeForecast(forecast, now = Date.now()) {
  const days = Array.isArray(forecast?.days) ? forecast.days : [];
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const eligible = (forecast?.hours ?? []).filter((hour) => {
    const day = dayByDate.get(hour.date);
    return isNumber(hour.time) && hour.time >= now && day && validSunTimes(day)
      && hour.time >= day.sunrise;
  }).sort((left, right) => left.time - right.time);
  const completeScores = scoreHours(eligible.filter((hour) => hasMetrics(hour, ALL_METRICS)), true);
  const weatherScores = scoreHours(eligible.filter((hour) => hasMetrics(hour, WEATHER_METRICS)), false);
  const analyzedDays = days.map((day) => {
    const hours = eligible.filter((hour) => hour.date === day.date);
    const daylight = hours.filter((hour) => hour.time < day.sunset);
    const afterDark = hours.filter((hour) => hour.time >= day.sunset);
    const noSun = 'Sunrise or sunset is unavailable for this date.';
    return {
      ...day,
      daylight: pickPeriod(daylight, completeScores, weatherScores,
        validSunTimes(day) ? 'No upcoming daylight hours.' : noSun),
      afterDark: pickPeriod(afterDark, completeScores, weatherScores,
        validSunTimes(day) ? 'No upcoming hours after sunset.' : noSun),
    };
  });
  const minima = Object.fromEntries(ALL_METRICS.map((metric) => {
    const available = eligible.filter((hour) => isNumber(hour[metric]));
    if (!available.length) return [metric, null];
    const value = Math.min(...available.map((hour) => hour[metric]));
    return [metric, { value, times: available.filter((hour) => hour[metric] === value) }];
  }));
  return {
    days: analyzedDays,
    bestDaylight: earliestLowest(analyzedDays.filter((day) => day.daylight.complete).map((day) => day.daylight.best)),
    bestAfterDark: earliestLowest(analyzedDays.filter((day) => day.afterDark.complete).map((day) => day.afterDark.best)),
    minima,
  };
}
