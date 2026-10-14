import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ESRI_REFERENCE_CREDIT_HTML,
  ESRI_WORLD_BOUNDARIES_AND_PLACES_URL,
  ESRI_WORLD_TRANSPORTATION_URL,
  createEsriReferenceImagery,
} from '../../maps/imagery.js';

test('Esri reference factories keep the published service URLs and credits', async () => {
  const calls = [];
  const fromUrl = async (url, options) => {
    calls.push({ url, options });
    return { url };
  };
  const roads = await createEsriReferenceImagery(
    ESRI_WORLD_TRANSPORTATION_URL,
    {
      fromUrl,
    },
  );
  const labels = await createEsriReferenceImagery(
    ESRI_WORLD_BOUNDARIES_AND_PLACES_URL,
    { fromUrl },
  );
  assert.equal(
    roads.url,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer',
  );
  assert.equal(
    labels.url,
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer',
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.enablePickFeatures, false);
    assert.equal(call.options.credit, ESRI_REFERENCE_CREDIT_HTML);
    assert.match(call.options.credit, /Powered by Esri/);
    assert.match(
      call.options.credit,
      /Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community/,
    );
    assert.match(call.options.credit, /href="https:\/\/www\.esri\.com"/);
  }
  assert.throws(() => createEsriReferenceImagery(''), TypeError);
});
