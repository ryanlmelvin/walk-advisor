const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REQUEST_TIMEOUT = 18000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = (value, minimum = -Infinity, maximum = Infinity) =>
  finite(value) && value >= minimum && value <= maximum ? value : null;
const timestamp = (seconds) => finite(seconds) && seconds > 0 ? seconds * 1000 : null;

function endpoint(base, parameters) {
  const url = new URL(base);
  url.search = new URLSearchParams(parameters).toString();
  return url;
}

function abortIfRequested(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Request cancelled', 'AbortError');
}

async function requestJSON(url, signal, service) {
  abortIfRequested(signal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 429) throw new Error(`${service} is busy. Please try again in a minute.`);
      throw new Error(`${service} is unavailable (${response.status}). Please try again.`);
    }
    const data = await response.json();
    if (!data || data.error) throw new Error(`${service} could not return this forecast. Please try again.`);
    return data;
  } catch (error) {
    abortIfRequested(signal);
    if (timedOut) throw new Error(`${service} took too long to respond. Please try again.`);
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw new Error(`Could not reach ${service.toLowerCase()}. Check your connection and try again.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function dateFormatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function localDate(time, formatter) {
  // formatToParts avoids depending on the browser's locale date separators.
  const parts = Object.fromEntries(formatter.formatToParts(time).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validHourly(data, fields) {
  const hourly = data?.hourly;
  return Array.isArray(hourly?.time) && hourly.time.length > 0
    && fields.every((field) => Array.isArray(hourly[field]) && hourly[field].length === hourly.time.length);
}

function validateLocation(location) {
  if (!location || !finite(location.latitude) || Math.abs(location.latitude) > 90
    || !finite(location.longitude) || Math.abs(location.longitude) > 180) {
    throw new Error('Choose a location with a valid latitude and longitude.');
  }
}

/** Search place names or postal codes. Results are locality centers, not address geocodes. */
export async function searchLocations(query, { signal } = {}) {
  const name = String(query ?? '').trim();
  if (name.length < 2) return [];
  const data = await requestJSON(endpoint(GEOCODING_URL, {
    name, count: '8', language: 'en', format: 'json',
  }), signal, 'Location search');
  if (data.results !== undefined && !Array.isArray(data.results)) {
    throw new Error('Location search returned an unreadable result. Please try again.');
  }
  return (data.results ?? []).filter((place) => finite(place.latitude) && finite(place.longitude))
    .map((place) => ({
      name: String(place.name ?? 'Selected location'),
      label: [...new Set([place.name, place.admin1, place.country].filter(Boolean))].join(', '),
      latitude: place.latitude,
      longitude: place.longitude,
      ...(typeof place.timezone === 'string' ? { timezone: place.timezone } : {}),
    }));
}

/**
 * Obtain seven calendar days in the selected location's time zone. All instants
 * are epoch milliseconds. Temperature and AQI describe the walk-start instant;
 * precipitation amount/probability and mean UV describe the following hour.
 * Open-Meteo reports those aggregates for the preceding hour, so they come from
 * the next absolute timestamp. An eighth weather day supplies the last boundary
 * hour but is not exposed. Missing AQI remains null, even beyond its shorter
 * model horizon. Partial AQI failure does not discard usable weather.
 */
export async function fetchForecast(location, { signal } = {}) {
  validateLocation(location);
  const common = {
    latitude: String(location.latitude), longitude: String(location.longitude),
    timezone: 'auto', timeformat: 'unixtime', forecast_days: '7',
  };
  const [weatherResult, airResult] = await Promise.allSettled([
    requestJSON(endpoint(WEATHER_URL, {
      ...common,
      forecast_days: '8',
      hourly: 'temperature_2m,precipitation_probability,precipitation,uv_index',
      daily: 'sunrise,sunset', temperature_unit: 'fahrenheit', precipitation_unit: 'mm',
    }), signal, 'Weather forecast'),
    requestJSON(endpoint(AIR_URL, { ...common, hourly: 'us_aqi' }), signal, 'Air quality forecast'),
  ]);
  abortIfRequested(signal);
  if (weatherResult.status === 'rejected') throw weatherResult.reason;
  const weather = weatherResult.value;
  if (!validHourly(weather, ['temperature_2m', 'precipitation_probability', 'precipitation', 'uv_index'])
    || !Array.isArray(weather.daily?.time)
    || !Array.isArray(weather.daily?.sunrise) || !Array.isArray(weather.daily?.sunset)
    || weather.daily.sunrise.length !== weather.daily.time.length
    || weather.daily.sunset.length !== weather.daily.time.length
    || !weather.daily.time.length) {
    throw new Error('Weather forecast returned incomplete data. Please try refreshing.');
  }
  const timezone = weather.timezone ?? location.timezone ?? 'UTC';
  let formatter;
  try { formatter = dateFormatter(timezone); } catch {
    throw new Error('Weather forecast returned an invalid time zone. Please try refreshing.');
  }
  const warnings = [];
  const air = airResult.status === 'fulfilled' && validHourly(airResult.value, ['us_aqi'])
    ? airResult.value : null;
  if (!air) warnings.push('Air quality forecast is unavailable. Suggestions use weather only until AQI returns.');
  const airByTime = new Map((air?.hourly.time ?? []).map((time, index) =>
    [timestamp(time), numberOrNull(air.hourly.us_aqi[index], 0)]));
  const days = weather.daily.time.slice(0, 7).flatMap((seconds, index) => {
    const time = timestamp(seconds);
    return time === null ? [] : [{
      // Daily array labels use the API's fixed request-time UTC offset even
      // when DST changes later in the range. Hourly instants below use the
      // real IANA zone, but these labels must retain their API calendar date.
      date: finite(weather.utc_offset_seconds)
        ? new Date(time + weather.utc_offset_seconds * 1000).toISOString().slice(0, 10)
        : localDate(time, formatter),
      sunrise: timestamp(weather.daily.sunrise[index]),
      sunset: timestamp(weather.daily.sunset[index]),
    }];
  });
  const knownDates = new Set(days.map((day) => day.date));
  const weatherIndexByTime = new Map(weather.hourly.time.map((seconds, index) => [timestamp(seconds), index]));
  const hours = weather.hourly.time.flatMap((seconds, index) => {
    const time = timestamp(seconds);
    if (time === null) return [];
    const date = localDate(time, formatter);
    if (!knownDates.has(date)) return [];
    // Look up by instant, never by array position: DST and sparse responses
    // must not shift the following-hour aggregate to an unrelated interval.
    const nextIndex = weatherIndexByTime.get(time + 3600000);
    return [{
      time, date,
      temperature: numberOrNull(weather.hourly.temperature_2m[index]),
      precipitationProbability: numberOrNull(weather.hourly.precipitation_probability[nextIndex], 0, 100),
      precipitation: numberOrNull(weather.hourly.precipitation[nextIndex], 0),
      uv: numberOrNull(weather.hourly.uv_index[nextIndex], 0),
      aqi: airByTime.get(time) ?? null,
    }];
  }).sort((left, right) => left.time - right.time);
  if (!days.length || !hours.length) throw new Error('No hourly forecast was returned for this location. Please try again.');
  if (air && hours.some((hour) => hour.aqi === null)) {
    warnings.push('AQI does not cover every hour of the week. Those suggestions use weather only.');
  }
  return {
    location: { ...location, timezone }, fetchedAt: Date.now(), days, hours, warnings,
    sources: {
      weather: 'Open-Meteo', airQuality: 'CAMS via Open-Meteo',
      weatherGrid: { latitude: weather.latitude, longitude: weather.longitude, elevation: weather.elevation },
      airQualityGrid: air ? { latitude: air.latitude, longitude: air.longitude } : null,
    },
  };
}
