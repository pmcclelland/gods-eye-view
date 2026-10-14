import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

/** Fused road lines, shields, and high-zoom transit/landmark labels. No sublayers. */
export const ESRI_WORLD_TRANSPORTATION_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer';

/** Fused place names and the service's own thin admin lines. No sublayers. */
export const ESRI_WORLD_BOUNDARIES_AND_PLACES_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer';

/** Attribution sentence published by the Esri reference map services. */
export const ESRI_REFERENCE_ATTRIBUTION =
  'Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community';

export const ESRI_REFERENCE_CREDIT_HTML = `${ESRI_ATTRIBUTION_HTML} — ${ESRI_REFERENCE_ATTRIBUTION}`;

/**
 * A keyless Esri reference overlay. `fromUrl` resolves to an imagery provider;
 * callers await it before constructing an ImageryLayer.
 * @param {string} url ArcGIS MapServer root.
 * @param {{ fromUrl?: Function, credit?: string }} [options]
 */
export function createEsriReferenceImagery(url, options = {}) {
  if (typeof url !== 'string' || !url) {
    throw new TypeError('Esri reference imagery requires a service URL');
  }
  const fromUrl =
    options.fromUrl ||
    ((serviceUrl, providerOptions) =>
      Cesium.ArcGisMapServerImageryProvider.fromUrl(
        serviceUrl,
        providerOptions,
      ));
  return fromUrl(url, {
    credit: options.credit ?? ESRI_REFERENCE_CREDIT_HTML,
    enablePickFeatures: false,
  });
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}
