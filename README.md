# Walk Window

A small, installable web app that compares upcoming dog-walking hours using precipitation, US AQI, UV index, and temperature. It runs entirely in the browser with free public APIs and no API key.

By [Ryan L. Melvin](https://ryanlmelvin.com).

## Run locally

Requires Node.js 22 or newer. There are no package dependencies to install.

```sh
npm run check
npm test
npm run build
npm start
```

Open [http://127.0.0.1:4319/walk-advisor/](http://127.0.0.1:4319/walk-advisor/). Rebuild after source changes, then accept the app update or reload. The preview server serves `dist/` under the same subpath used by GitHub Pages.

## GitHub Pages

The source is at [ryanlmelvin/walk-advisor](https://github.com/ryanlmelvin/walk-advisor), with Pages at [https://ryanlmelvin.github.io/walk-advisor/](https://ryanlmelvin.github.io/walk-advisor/).

In repository **Settings → Pages**, select **GitHub Actions** as the build source. Pushing to `main`, or manually running **Deploy to GitHub Pages**, runs syntax checks, tests, and the build before publishing `dist/`. The workflow is [`.github/workflows/pages.yml`](.github/workflows/pages.yml). A successful workflow and a live-page check are required to confirm publication.

Assets, manifest, and service-worker scope use relative paths. The build fingerprints JavaScript/CSS and creates a release identifier automatically; no manual cache-version bump is needed.

## Use and install

Choose a city/ZIP, enter `latitude, longitude`, or use the device-location button. Day view shows two picks for the selected day; Week view compares the seven calendar days beginning today. The hourly grid shows hours across columns and precipitation, US AQI, UV index, and temperature down the rows. Scroll sideways to compare hours; the criteria labels stay in place. Green columns with a check mark meet all your cutoffs.

Use **App options → Walk start times** to set the earliest and latest allowed start. The defaults are **8:00 AM–9:00 PM**, inclusive, in the forecast location's time zone. The cutoff defaults are **32–80°F**, **33% precipitation chance**, **US AQI 50**, and **UV 5**. Leave any cutoff blank for no limit. **Save preferences** applies the walking hours to recommendations and the hourly grid. Cutoffs filter recommendations and highlight matching grid columns; hours outside the cutoffs remain visible for comparison. Preferences remain on this device across app updates. The latest time must be at or after the earliest on the same day; a bound between hourly points selects only points inside the range.

The temperature settings link to [Rover’s temperature chart](https://www.rover.com/blog/hot-weather-dogs/#when-is-it-too-hot-or-cold-to-walk-a-dog) and state: “Consult a chart like this one. This app is not affiliated with Rover in any way.” A prominent note at the bottom of the day/week forecasts links to [RSPCA guidance](https://www.rspca.org.uk/adviceandwelfare/seasonal/summer/dogs): if a surface is too hot to hold your hand on for five seconds without pain, it is too hot for your dog's paws.

In a supported desktop or Android browser, use **App options → Install app** or the browser's install control. On iPhone/iPad, open the HTTPS site in Safari and choose **Share → Add to Home Screen**.

The app saves its last location and forecast on the device. It can reopen offline, showing when the forecast was saved; saved or stale information is not a fresh observation. New forecasts need an internet connection. Updates are checked automatically on startup, on returning to the app, on reconnecting, and once a minute while visible. A top-level **Update available** button offers a downloaded update without forcing a reload. [`update.html`](public/update.html) provides network-only update recovery without clearing saved preferences or the forecast.

## How picks work

- Compare upcoming hourly points only. A point earlier than the current time is excluded; this does not recommend the remainder of the current hour.
- **Before sunset** means sunrise up to sunset. **After sunset** means sunset up to local midnight. Pre-dawn hours are excluded from both recommendations and the hourly grid. Dates and times use the selected location's time zone.
- Temperature and AQI describe the suggested start. Precipitation probability and average UV describe the following hour. Open-Meteo reports these aggregates at the hour's end, so the app aligns them to the prior start using absolute timestamps. It requests one extra weather day to obtain the final boundary, and shows only dates with complete data for the requested walking hours.
- Lower temperature, UV, AQI, and precipitation each get equal weight. Each value is converted to its percentile rank among eligible forecast hours. Precipitation uses chance only. Precipitation amount does not affect ranking. The four factor ranks are then averaged; ties go to the earliest hour. Different variables can have their minima at different times, so a combined pick is a compromise.
- Complete-data hours share one comparison population for consistent day/week picks. Both views stop at the shared forecast range, before the first date missing any requested upcoming walking-hour reading. Cutoffs do not affect date availability. Missing values are never zero.
- Hours outside the configured cutoffs are excluded before ranking; the app says when none qualify. Cutoffs are inclusive, and zero remains a real limit. Within the allowed temperature range, colder ranks better. Weather-only picks must satisfy known weather cutoffs but cannot be checked against the AQI cutoff. These relative picks do not declare conditions safe for a dog, and an hourly forecast point does not guarantee conditions throughout a walk.

## Data sources and limits

[Open-Meteo weather](https://open-meteo.com/en/docs) supplies hourly temperature, precipitation probability, UV, and daily sunrise/sunset. [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) searches locality centers. Device location or entered coordinates provide a more precise lookup, but the forecasts remain weather-model estimates; resolution varies by model, region, and forecast horizon. Precipitation probability uses approximately 27 km ensemble models. A precise coordinate is not a backyard measurement.

[CAMS air quality via Open-Meteo](https://open-meteo.com/en/docs/air-quality-api) supplies modeled US AQI, at approximately 11 km in Europe and 45 km globally. Although the endpoint accepts seven-day requests, underlying models generally cover about four days in Europe and five globally. Unavailable hours remain missing and are labeled accordingly. AQI and UV are requested separately so shorter AQI coverage does not discard the weather API's longer UV forecast. The app credits Open-Meteo and CAMS.

[IQAir's free Community API](https://www.iqair.com/air-quality-monitors/api) provides current city-level AQI and weather. Individual station access requires a paid plan, and forecasts require Enterprise. It therefore cannot provide the requested free, hyperlocal hourly forecasts and is not used for ranking. A future current-observation integration should remain distinct from forecast data; a shared secret cannot be hidden in a static website.

Open-Meteo's hosted free API is for [noncommercial use](https://open-meteo.com/en/terms), with limits of fewer than 10,000 calls/day, 5,000/hour, and 600/minute. Data attribution follows [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Requests send the selected coordinates directly to Open-Meteo. Commercial use, ads, or subscriptions require revisiting the provider's plan and terms.

## License

Copyright © 2026 [Ryan L. Melvin](https://ryanlmelvin.com). App code and original artwork are licensed under [GNU GPL version 3](LICENSE) (`GPL-3.0-only`). You may redistribute and modify them under that license. This software comes without any warranty; see the license for details.

The app bundles no third-party libraries, fonts, or artwork. Weather and air-quality data are fetched at runtime and retain their separate data license and API terms above. The build includes the full GPLv3 text, linked from **App options → About**.
