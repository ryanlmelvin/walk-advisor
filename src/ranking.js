const WEATHER_METRICS = ['temperature', 'uv', 'precipitationProbability', 'precipitation'];
const ALL_METRICS = [...WEATHER_METRICS, 'aqi'];
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const hasMetrics = (hour, metrics) => metrics.every((metric) => isNumber(hour[metric]));
const DEFAULT_WALKING_HOURS = Object.freeze({ earliest: '08:00', latest: '21:00' });
const DEFAULT_CUTOFFS = Object.freeze({
  minTemperature: 32, maxTemperature: 80, maxPrecipitationProbability: 33, maxAqi: 50, maxUv: 5,
});
const clockFormatters = new Map();

function normalizeCutoffs(cutoffs) {
  const result = Object.fromEntries(Object.entries(DEFAULT_CUTOFFS).map(([key, defaultValue]) => {
    const value = cutoffs?.[key];
    if (value === null || (typeof value === 'string' && value.trim() === '')) return [key, null];
    if (value === undefined) return [key, defaultValue];
    const number = typeof value === 'string' ? Number(value) : value;
    return [key, isNumber(number) ? number : defaultValue];
  }));
  if (result.minTemperature !== null && result.maxTemperature !== null
    && result.minTemperature > result.maxTemperature) {
    result.minTemperature = DEFAULT_CUTOFFS.minTemperature;
    result.maxTemperature = DEFAULT_CUTOFFS.maxTemperature;
  }
  return result;
}

/**
 * Check inclusive hard limits before ranking. An omitted property uses its
 * default; null or an empty string disables it, while zero remains a limit.
 * Missing data cannot satisfy an enabled weather limit. Missing AQI is only
 * allowed when explicitly requested for a weather-only suggestion, and does
 * not mean the AQI limit has been checked. Known AQI still must meet its limit.
 */
export function isWithinCutoffs(hour, cutoffs = DEFAULT_CUTOFFS, { allowMissingAqi = false } = {}) {
  if (!hour || (!isNumber(hour.aqi) && !allowMissingAqi)) return false;
  const bounds = normalizeCutoffs(cutoffs);
  const aboveMinimum = (metric, bound) => bound === null || (isNumber(hour[metric]) && hour[metric] >= bound);
  const belowMaximum = (metric, bound) => bound === null || (isNumber(hour[metric]) && hour[metric] <= bound);
  return aboveMinimum('temperature', bounds.minTemperature)
    && belowMaximum('temperature', bounds.maxTemperature)
    && belowMaximum('precipitationProbability', bounds.maxPrecipitationProbability)
    && belowMaximum('uv', bounds.maxUv)
    && ((!isNumber(hour.aqi) && allowMissingAqi) || belowMaximum('aqi', bounds.maxAqi));
}

function normalizeWalkingHours(walkingHours) {
  const validTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return validTime(walkingHours?.earliest) && validTime(walkingHours?.latest)
    && walkingHours.earliest <= walkingHours.latest ? walkingHours : DEFAULT_WALKING_HOURS;
}

/**
 * Whether this start instant is within inclusive HH:mm bounds in the forecast
 * location's IANA time zone (never the browser's zone). Invalid bounds fall
 * back together to 08:00–21:00. This helper applies only the clock constraint;
 * callers still exclude past and pre-dawn points when showing eligible hours.
 */
export function isWithinWalkingHours(hour, timezone = 'UTC', walkingHours = DEFAULT_WALKING_HOURS) {
  if (!isNumber(hour?.time)) return false;
  const bounds = normalizeWalkingHours(walkingHours);
  const zone = timezone || 'UTC';
  let formatter = clockFormatters.get(zone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
    } catch {
      return false;
    }
    clockFormatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(hour.time).map(({ type, value }) => [type, value]));
  const clock = `${parts.hour}:${parts.minute}`;
  return clock >= bounds.earliest && clock <= bounds.latest;
}

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

function pickPeriod(hours, completeScores, weatherScores, missingReason, hasAqiCutoff) {
  const complete = hours.map((hour) => completeScores.get(hour.time)).filter(Boolean);
  if (complete.length) return { best: earliestLowest(complete), complete: true, reason: null };
  const weather = hours.map((hour) => weatherScores.get(hour.time)).filter(Boolean);
  if (weather.length) return {
    best: earliestLowest(weather), complete: false,
    reason: `AQI unavailable; weather-only suggestion.${hasAqiCutoff ? ' AQI cutoff cannot be checked.' : ''}`,
  };
  return {
    best: null, complete: false,
    reason: hours.length ? 'Forecast unavailable.' : missingReason,
  };
}

/**
 * Compare upcoming hourly points during daylight and from sunset to midnight.
 * Four factors have equal weight: temperature, UV, AQI, and precipitation
 * (the average of probability and amount). Lower percentile is better; ties
 * choose the earliest hour. Hard cutoffs remove nonqualifying hours first.
 * All complete hours share one reference population, so daily and weekly picks
 * agree. Weather-only picks share a separate population and are never promoted
 * to the all-factor weekly recommendations. Missing values are never zero.
 * Individual metric minima use the same eligible upcoming hours, including
 * hours with a missing different metric; each result includes every tied hour.
 * Earliest/latest walk-start times are inclusive in the location's time zone;
 * defaults are 08:00 and 21:00. They constrain ranks, minima, and every pick.
 * Default cutoffs are temperature 32–80°F, precipitation chance ≤33%, AQI ≤50,
 * and UV ≤5. Null/blank disables a cutoff. Weather-only fallbacks must satisfy
 * the weather limits, but never imply the missing AQI passed its cutoff.
 */
export function analyzeForecast(forecast, now = Date.now(), walkingHours = DEFAULT_WALKING_HOURS, cutoffs = DEFAULT_CUTOFFS) {
  const days = Array.isArray(forecast?.days) ? forecast.days : [];
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  const bounds = normalizeCutoffs(cutoffs);
  const timeEligible = (forecast?.hours ?? []).filter((hour) => {
    const day = dayByDate.get(hour.date);
    return isNumber(hour.time) && hour.time >= now && day && validSunTimes(day)
      && hour.time >= day.sunrise
      && isWithinWalkingHours(hour, forecast.location?.timezone ?? 'UTC', walkingHours);
  }).sort((left, right) => left.time - right.time);
  const eligible = timeEligible.filter((hour) => isWithinCutoffs(hour, bounds, { allowMissingAqi: true }));
  const completeScores = scoreHours(eligible.filter((hour) => hasMetrics(hour, ALL_METRICS)), true);
  const weatherScores = scoreHours(eligible.filter((hour) => hasMetrics(hour, WEATHER_METRICS)), false);
  const analyzedDays = days.map((day) => {
    const hours = eligible.filter((hour) => hour.date === day.date);
    const daylight = hours.filter((hour) => hour.time < day.sunset);
    const afterDark = hours.filter((hour) => hour.time >= day.sunset);
    const noSun = 'Sun times unavailable.';
    return {
      ...day,
      daylight: pickPeriod(daylight, completeScores, weatherScores,
        validSunTimes(day) ? 'No matching hours.' : noSun,
        bounds.maxAqi !== null),
      afterDark: pickPeriod(afterDark, completeScores, weatherScores,
        validSunTimes(day) ? 'No matching hours.' : noSun,
        bounds.maxAqi !== null),
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
