import axios from "axios";
import logger from "../logger.js";

/**
 * Get city boundaries from OpenStreetMap Nominatim API (free, no API key needed)
 * Returns bounding box coordinates
 */
export async function getCityBoundingBox(cityName, stateCode, countryCode) {
  try {
    // Build search query
    const searchParts = [cityName];
    if (stateCode) searchParts.push(stateCode);
    if (countryCode) searchParts.push(countryCode);

    const query = searchParts.join(", ");

    logger.info("GEOCODING_REQUEST", "Fetching city boundaries", {
      city: cityName,
      state: stateCode,
      country: countryCode,
    });

    const response = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: {
          q: query,
          format: "json",
          limit: 1,
          addressdetails: 1,
        },
        headers: {
          "User-Agent": "LeadSourcingApp/1.0", // Nominatim requires User-Agent
        },
        timeout: 10000,
      }
    );

    if (!response.data || response.data.length === 0) {
      logger.warn("GEOCODING_NO_RESULTS", "No results from geocoding", {
        query,
      });
      return null;
    }

    const result = response.data[0];

    // Nominatim returns boundingbox as [south, north, west, east]
    if (!result.boundingbox || result.boundingbox.length !== 4) {
      logger.warn("GEOCODING_NO_BBOX", "No bounding box in result", { query });
      return null;
    }

    const [south, north, west, east] = result.boundingbox.map(parseFloat);

    const bounds = {
      north,
      south,
      east,
      west,
      center: {
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
      },
    };

    logger.info("GEOCODING_SUCCESS", "Retrieved city boundaries", {
      city: cityName,
      bounds,
    });

    return bounds;
  } catch (error) {
    logger.error("GEOCODING_ERROR", "Error fetching city boundaries", {
      city: cityName,
      error: error.message,
    });
    return null;
  }
}

/**
 * Generate a batch of grid points for a specific range
 * @param {Object} bounds - {north, south, east, west}
 * @param {number} gridSpacingKm - Distance between grid points in kilometers
 * @param {number} startIndex - Starting zone index
 * @param {number} endIndex - Ending zone index (exclusive)
 * @returns {Array} Array of {lat, lng, label} objects for this batch
 */
export function generateCityGridBatch(
  bounds,
  gridSpacingKm,
  startIndex,
  endIndex
) {
  if (!bounds) return [];

  const { north, south, east, west } = bounds;

  // Approximate conversion: 1 degree latitude ≈ 111 km
  const avgLat = (north + south) / 2;
  const latSpacing = gridSpacingKm / 111;
  const lngSpacing = gridSpacingKm / (111 * Math.cos((avgLat * Math.PI) / 180));

  const points = [];
  let gridIndex = 0;

  // Generate only the zones in the requested range
  outerLoop: for (let lat = south; lat <= north; lat += latSpacing) {
    for (let lng = west; lng <= east; lng += lngSpacing) {
      if (gridIndex >= startIndex && gridIndex < endIndex) {
        points.push({
          lat: parseFloat(lat.toFixed(6)),
          lng: parseFloat(lng.toFixed(6)),
          label: `zone-${gridIndex}`,
          type: "grid",
        });
      }
      gridIndex++;

      // Stop if we've passed the end index
      if (gridIndex >= endIndex) break outerLoop;
    }
  }

  return points;
}

/**
 * Calculate total possible zones for a city
 * @param {Object} bounds - {north, south, east, west}
 * @param {number} gridSpacingKm - Distance between grid points in kilometers
 * @returns {number} Total number of possible zones
 */
export function calculateTotalPossibleZones(bounds, gridSpacingKm) {
  if (!bounds) return 0;

  const { north, south, east, west } = bounds;
  const avgLat = (north + south) / 2;

  const latSpacing = gridSpacingKm / 111;
  const lngSpacing = gridSpacingKm / (111 * Math.cos((avgLat * Math.PI) / 180));

  const rowCount = Math.ceil((north - south) / latSpacing);
  const colCount = Math.ceil((east - west) / lngSpacing);

  return rowCount * colCount;
}

/**
 * Determine optimal grid spacing based on city size and population
 * @param {Object} bounds - City bounding box
 * @param {number|null} population - City population (optional)
 * @returns {number} Recommended grid spacing in km
 */
export function getOptimalGridSpacing(bounds, population = null) {
  if (!bounds) return 3; // default

  const { north, south, east, west } = bounds;

  // Calculate approximate area
  const latDiff = north - south;
  const lngDiff = east - west;
  const avgLat = (north + south) / 2;

  // Approximate area in km²
  const areaKm2 =
    latDiff * 111 * lngDiff * 111 * Math.cos((avgLat * Math.PI) / 180);

  // Adjust spacing based on city size
  if (areaKm2 < 50) {
    // Small city (< 50 km²) - fine grid
    return 1.5;
  } else if (areaKm2 < 200) {
    // Medium city (50-200 km²) - medium grid
    return 2.5;
  } else if (areaKm2 < 1000) {
    // Large city (200-1000 km²) - wider grid
    return 4;
  } else {
    // Very large city (> 1000 km²) - very wide grid
    return 6;
  }
}

/**
 * Create zone generator for batched city scraping
 * Returns configuration for generating zones in batches
 * @param {string} cityName
 * @param {string} stateCode
 * @param {string} countryCode
 * @param {number|null} population
 * @param {boolean} enableDeepScrape - If false, only return city center
 * @param {number} batchSize - Zones per batch (default 25)
 * @param {number} maxTotalZones - Maximum total zones across all batches (default 200)
 * @returns {Object} Zone generation configuration
 */
export async function createCityZones(
  cityName,
  stateCode,
  countryCode,
  population = null,
  enableDeepScrape = true,
  batchSize = 25,
  maxTotalZones = 200
) {
  // City center zone (always included)
  const centerZone = {
    type: "city",
    cityName,
    stateCode,
    label: "city-center",
    coords: null,
  };

  // If deep scrape disabled, return just the city center
  if (!enableDeepScrape) {
    return {
      centerZone,
      bounds: null,
      gridSpacing: null,
      totalPossibleZones: 0,
      batchSize: 0,
      maxTotalZones: 0,
    };
  }

  // Get city boundaries
  const bounds = await getCityBoundingBox(cityName, stateCode, countryCode);

  if (!bounds) {
    logger.warn(
      "ZONE_GENERATION_FALLBACK",
      "Could not get boundaries, using city center only",
      {
        city: cityName,
      }
    );
    return {
      centerZone,
      bounds: null,
      gridSpacing: null,
      totalPossibleZones: 0,
      batchSize: 0,
      maxTotalZones: 0,
    };
  }

  // Determine optimal grid spacing
  const gridSpacing = getOptimalGridSpacing(bounds, population);

  // Calculate total possible zones
  const totalPossibleZones = calculateTotalPossibleZones(bounds, gridSpacing);

  logger.info("CITY_ZONES_CONFIG", "Prepared batched zone generation", {
    city: cityName,
    gridSpacingKm: gridSpacing,
    totalPossibleZones,
    batchSize,
    maxTotalZones,
    estimatedBatches: Math.ceil(
      Math.min(totalPossibleZones, maxTotalZones) / batchSize
    ),
  });

  return {
    centerZone,
    bounds,
    gridSpacing,
    totalPossibleZones,
    batchSize,
    maxTotalZones,
    cityName,
    stateCode,
  };
}

/**
 * Generate a batch of zones
 * @param {Object} zoneConfig - Configuration from createCityZones
 * @param {number} batchNumber - Which batch to generate (0-indexed)
 * @returns {Array} Array of zone objects for this batch
 */
export function generateZoneBatch(zoneConfig, batchNumber) {
  const { bounds, gridSpacing, batchSize, maxTotalZones, cityName, stateCode } =
    zoneConfig;

  if (!bounds || !gridSpacing) return [];

  const startIndex = batchNumber * batchSize;
  const endIndex = Math.min(startIndex + batchSize, maxTotalZones);

  if (startIndex >= maxTotalZones) return [];

  const gridPoints = generateCityGridBatch(
    bounds,
    gridSpacing,
    startIndex,
    endIndex
  );

  // Convert grid points to zone objects
  const zones = gridPoints.map((point) => ({
    type: "grid",
    cityName,
    stateCode,
    label: point.label,
    coords: { lat: point.lat, lng: point.lng },
  }));

  logger.info("ZONE_BATCH_GENERATED", "Generated zone batch", {
    city: cityName,
    batchNumber,
    batchSize: zones.length,
    zoneRange: `${startIndex}-${startIndex + zones.length - 1}`,
  });

  return zones;
}
