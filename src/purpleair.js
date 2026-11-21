/** Empty means optional, null means invalid. Store IDs as canonical decimal strings. */
export function normalizeSensorId(value) {
  if (value == null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).trim();
  if (!digits) return '';
  const number = Number(digits);
  return /^\d+$/.test(digits) && Number.isSafeInteger(number) && number > 0 ? String(number) : null;
}

export function watchSensorInputViewport(input) {
  const doc = input.ownerDocument;
  const view = doc.defaultView;
  const viewport = view.visualViewport;
  if (!viewport) return;
  let framePending = false;

  function checkAfterLayout() {
    if (doc.activeElement !== input || framePending) return;
    framePending = true;
    view.requestAnimationFrame(() => {
      framePending = false;
      if (doc.activeElement !== input) return;
      // A keyboard can pan the visual viewport independently of the layout viewport.
      // Compare both edges in page coordinates after the browser has moved the caret.
      const rect = input.getBoundingClientRect();
      const top = rect.top - doc.documentElement.getBoundingClientRect().top;
      if (top < viewport.pageTop || top + rect.height > viewport.pageTop + viewport.height) {
        input.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    });
  }
  input.addEventListener('focus', checkAfterLayout);
  input.addEventListener('input', checkAfterLayout);
  viewport.addEventListener('resize', checkAfterLayout);
}

export function sensorWidgetDocument(sensorId) {
  const id = normalizeSensorId(sensorId);
  if (!id) return '';
  const conversion = 'C5'; // PurpleAir's current US EPA sensor correction.
  const containerId = `PurpleAirWidget_${id}_module_US_EPA_AQI_conversion_${conversion}_average_10_layer_US_EPA_AQI`;
  return `<!doctype html><html lang="en"><head>
    <meta name="referrer" content="no-referrer">
    <style>
      body { margin: 0; font: 1rem system-ui, sans-serif; color: #24392d; }
      a { color: inherit; }
      @media (max-width: 460px) {
        body .current-conditions .legend-tooltiptext {
          position: fixed; inset: auto auto .25rem .25rem; margin: 0; max-width: calc(100vw - 2rem);
        }
        body .current-conditions .legend-tooltiptext::after { display: none; }
      }
    </style>
    </head><body>
    <div id="${containerId}"><span id="status" role="status">Loading sensor…</span>
      <a id="map" href="https://map.purpleair.com/1/mUS_EPA_AQI/a10/c${conversion}?select=${id}" target="_blank" rel="noreferrer" hidden>View sensor on PurpleAir</a>
    </div>
    <script>
      // The widget checks for a cookie even with no preferences. This isolated document has none.
      Object.defineProperty(document, 'cookie', {get: () => '', set: () => {}});
      function unavailable() {
        const status = document.getElementById('status');
        if (status) {
          status.textContent = 'Sensor reading unavailable.';
          document.getElementById('map').hidden = false;
        }
      }
      setTimeout(unavailable, 15000);
      new ResizeObserver(() => {
        parent.postMessage({purpleAirHeight: Math.ceil(document.body.getBoundingClientRect().height)}, '*');
      }).observe(document.body);
    </script>
    <script src="https://www.purpleair.com/pa.widget.js?module=US_EPA_AQI&amp;conversion=${conversion}&amp;average=10&amp;layer=US_EPA_AQI&amp;container=${containerId}" onerror="unavailable()"></script>
    </body></html>`;
}

function createSensorFrame(id) {
  const frame = document.createElement('iframe');
  frame.className = 'purpleair-widget';
  frame.title = `Current PM2.5 AQI from PurpleAir sensor ${id}`;
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
  frame.referrerPolicy = 'no-referrer';
  frame.height = '36';
  frame.srcdoc = sensorWidgetDocument(id);
  return frame;
}

function resizeSensorFrame(event) {
  const height = event.data?.purpleAirHeight;
  if (!Number.isFinite(height)) return;
  const frame = document.querySelector('iframe.purpleair-widget');
  if (frame && event.source === frame.contentWindow) frame.height = String(Math.max(36, Math.min(1200, height)));
}

export function renderPurpleAir(container, sensorId) {
  const id = normalizeSensorId(sensorId) || '';
  container.hidden = !id;
  if (container.dataset.sensorId === id) return;
  container.dataset.sensorId = id;
  container.replaceChildren();
  if (!id) return;

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Current PM2.5 AQI · PurpleAir';
  details.append(summary);
  details.addEventListener('toggle', () => {
    if (details.open) {
      if (!details.querySelector('iframe')) details.append(createSensorFrame(id));
    } else {
      details.querySelector('iframe')?.remove();
    }
  });
  window.addEventListener('message', resizeSensorFrame);
  container.append(details);
}
