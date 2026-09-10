/**
 * The radius-search map.
 *
 * MapLibre GL with a plain raster style over OpenStreetMap tiles, so the app
 * needs no map API key and no vector-tile provider. Clicking empty map drops
 * the search pin and sets lat/lon; clicking a result dot opens that parcel. The
 * radius is drawn as a real great-circle polygon rather than a screen-space
 * circle, so it stays honest as the map is panned and zoomed.
 *
 * GeoJSON payloads are described with local structural types rather than the
 * ambient `GeoJSON` namespace, so this file does not depend on which `@types`
 * packages happen to be hoisted.
 *
 * The only constants here are the opening camera position and the tile URL;
 * neither is a dataset figure.
 */

import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { num, parcelIdOf } from "../lib/rows.js";

/** Opening camera for the county. Superseded by "fit to results" once rows land. */
const INITIAL_CENTER: [number, number] = [-81.71, 28.76];
const INITIAL_ZOOM = 9;
const EARTH_RADIUS_MILES = 3958.7613;

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

const RESULTS_SOURCE = "search-results";
const RESULTS_LAYER = "search-results-dots";
const RADIUS_SOURCE = "search-radius";

interface PointFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { parcelId: string; label: string };
}

interface PolygonFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: Record<string, string>;
}

/** Build a great-circle polygon of `radiusMiles` around a point. */
function circlePolygon(lat: number, lon: number, radiusMiles: number, steps = 96): PolygonFeature {
  const angular = radiusMiles / EARTH_RADIUS_MILES;
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let index = 0; index <= steps; index += 1) {
    const bearing = (index / steps) * 2 * Math.PI;
    const pointLat = Math.asin(
      Math.sin(latRad) * Math.cos(angular) +
        Math.cos(latRad) * Math.sin(angular) * Math.cos(bearing),
    );
    const pointLon =
      lonRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(latRad),
        Math.cos(angular) - Math.sin(latRad) * Math.sin(pointLat),
      );
    ring.push([(pointLon * 180) / Math.PI, (pointLat * 180) / Math.PI]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

export function MapPanel({
  rows,
  center,
  radiusMiles,
  onPick,
  onOpenProperty,
}: {
  rows: readonly Record<string, unknown>[];
  center: { lat: number; lon: number } | null;
  radiusMiles: number | null;
  onPick: (lat: number, lon: number) => void;
  onOpenProperty: (parcelId: string) => void;
}): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pinRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);
  const onPickRef = useRef(onPick);
  const onOpenRef = useRef(onOpenProperty);
  onPickRef.current = onPick;
  onOpenRef.current = onOpenProperty;

  const features = useMemo<PointFeature[]>(() => {
    const out: PointFeature[] = [];
    for (const row of rows) {
      const lat = num(row, "latitude");
      const lon = num(row, "longitude");
      const parcelId = parcelIdOf(row);
      if (lat === null || lon === null || !parcelId) continue;
      const street = row.address_street;
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { parcelId, label: typeof street === "string" ? street : parcelId },
      });
    }
    return out;
  }, [rows]);

  // Create the map once, and tear it down on unmount.
  useEffect(() => {
    if (!container.current || mapRef.current) return undefined;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

    map.on("load", () => {
      map.addSource(RESULTS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addSource(RADIUS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "search-radius-fill",
        type: "fill",
        source: RADIUS_SOURCE,
        paint: { "fill-color": "#5fc6d9", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "search-radius-line",
        type: "line",
        source: RADIUS_SOURCE,
        paint: { "line-color": "#5fc6d9", "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      map.addLayer({
        id: RESULTS_LAYER,
        type: "circle",
        source: RESULTS_SOURCE,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 14, 6],
          "circle-color": "#5fc6d9",
          "circle-stroke-color": "#04262c",
          "circle-stroke-width": 1,
          "circle-opacity": 0.9,
        },
      });
      readyRef.current = true;
      map.getCanvas().style.cursor = "crosshair";
    });

    map.on("click", (event) => {
      if (readyRef.current && map.getLayer(RESULTS_LAYER)) {
        const hits = map.queryRenderedFeatures(event.point, { layers: [RESULTS_LAYER] });
        const properties: unknown = hits[0]?.properties;
        if (properties !== null && typeof properties === "object") {
          const parcelId = (properties as Record<string, unknown>).parcelId;
          if (typeof parcelId === "string" && parcelId.length > 0) {
            onOpenRef.current(parcelId);
            return;
          }
        }
      }
      onPickRef.current(event.lngLat.lat, event.lngLat.lng);
    });

    return () => {
      readyRef.current = false;
      pinRef.current?.remove();
      pinRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Push result points into the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = (): void => {
      const source = map.getSource(RESULTS_SOURCE);
      if (!source || !("setData" in source)) return;
      (source as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
    };
    if (readyRef.current) apply();
    else map.once("load", apply);
  }, [features]);

  // Draw the radius ring and the centre pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    pinRef.current?.remove();
    pinRef.current = null;
    if (center) {
      const element = document.createElement("div");
      element.className = "marker-pin";
      element.setAttribute("aria-label", "Radius search centre");
      pinRef.current = new maplibregl.Marker({ element })
        .setLngLat([center.lon, center.lat])
        .addTo(map);
    }

    const apply = (): void => {
      const source = map.getSource(RADIUS_SOURCE);
      if (!source || !("setData" in source)) return;
      const geoSource = source as maplibregl.GeoJSONSource;
      if (center && typeof radiusMiles === "number" && radiusMiles > 0) {
        geoSource.setData({
          type: "FeatureCollection",
          features: [circlePolygon(center.lat, center.lon, radiusMiles)],
        });
      } else {
        geoSource.setData({ type: "FeatureCollection", features: [] });
      }
    };
    if (readyRef.current) apply();
    else map.once("load", apply);
  }, [center, radiusMiles]);

  const fitToResults = (): void => {
    const map = mapRef.current;
    if (!map || features.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const feature of features) {
      const lon = feature.geometry.coordinates[0];
      const lat = feature.geometry.coordinates[1];
      bounds.extend([lon, lat]);
    }
    map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 500 });
  };

  const useMyLocation = (): void => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        onPickRef.current(latitude, longitude);
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 13, duration: 700 });
      },
      () => {
        // Permission denied or unavailable: degrade silently, as specified.
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    );
  };

  return (
    <div className="stack-sm">
      <div className="map-shell">
        <div ref={container} style={{ position: "absolute", inset: 0 }} />
        <div className="map-hint">
          Click the map to set the search centre · click a dot to open a parcel
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn small" onClick={useMyLocation}>
          Use my location
        </button>
        <button
          type="button"
          className="btn small ghost"
          onClick={fitToResults}
          disabled={features.length === 0}
        >
          Fit to results
        </button>
        <span className="dim" style={{ fontSize: 11 }}>
          Only parcels that carry FL GIO centroids can be plotted.
        </span>
      </div>
    </div>
  );
}
