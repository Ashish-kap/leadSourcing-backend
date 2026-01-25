import logger from "../logger.js";
import {
  getBoundingBox,
  generateGridBatch,
  calculateTotalPossibleZones,
  calculateAreaKm2
} from "./zoneGeneratorCommon.js";

/**
 * Get state boundaries from OpenStreetMap Nominatim API
 * @param {string} stateName - Name of the state
 * @param {string} stateCode - State code
 * @param {string} countryCode - Country code
 * @returns {Object|null} Bounding box {north, south, east, west, center} or null
 */
export async function getStateBoundingBox(stateName, stateCode, countryCode) {
  return getBoundingBox(stateName, stateCode, countryCode, "state");
}

/**
 * Generate a batch of grid points for state zones
 * @param {Object} bounds - {north, south, east, west}
 * @param {number} gridSpacingKm - Distance between grid points in kilometers
 * @param {number} startIndex - Starting zone index
 * @param {number} endIndex - Ending zone index (exclusive)
 * @param {boolean} enableOverlap - Whether to add overlapping zones for better coverage
 * @returns {Array} Array of {lat, lng, label, type} objects for this batch
 */
export function generateStateGridBatch(
  bounds,
  gridSpacingKm,
  startIndex,
  endIndex,
  enableOverlap = true
) {
  return generateGridBatch(bounds, gridSpacingKm, startIndex, endIndex, enableOverlap, "state-zone");
}

/**
 * Determine optimal grid spacing based on state size
 * States are larger than cities, so we use wider spacing
 * @param {Object} bounds - State bounding box
 * @param {number|null} population - State population (optional)
 * @returns {number} Recommended grid spacing in km
 */
export function getOptimalStateGridSpacing(bounds, population = null) {
  if (!bounds) return 2; // default - use city-like spacing for better coverage

  const areaKm2 = calculateAreaKm2(bounds);

  // Smart spacing strategy: Use city-like spacing for maximum coverage
  // This matches the city zone generator to ensure dense grids and more records
  if (areaKm2 < 25) {
    // Very small area (< 25 km²) - dense grid for maximum coverage
    return 1;
  } else if (areaKm2 < 50) {
    // Small area (< 50 km²) - tight grid
    return 2;
  } else if (areaKm2 < 200) {
    // Medium area (50-200 km²) - medium grid
    return 3;
  } else if (areaKm2 < 1000) {
    // Large area (200-1000 km²) - balanced grid
    return 4;
  } else {
    // Very large area (> 1000 km²) - wider grid to avoid excessive overlap
    return 5;
  }
}

/**
 * Create zone generator for batched state scraping
 * Returns configuration for generating zones in batches
 * @param {string} stateName
 * @param {string} stateCode
 * @param {string} countryCode
 * @param {number|null} population
 * @param {boolean} enableDeepScrape - If false, only return state center
 * @param {number} batchSize - Zones per batch (default 50)
 * @param {number} maxTotalZones - Maximum total zones across all batches (default 2000)
 * @returns {Object} Zone generation configuration
 */
export async function createStateZones(
  stateName,
  stateCode,
  countryCode,
  population = null,
  enableDeepScrape = true,
  batchSize = 50,
  maxTotalZones = 2000
) {
  // State center zone (always included)
  const centerZone = {
    type: "state",
    stateName,
    stateCode,
    label: "state-center",
    coords: null,
  };

  // If deep scrape disabled, return just the state center
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

  // Get state boundaries
  const bounds = await getStateBoundingBox(stateName, stateCode, countryCode);

  if (!bounds) {
    logger.warn(
      "STATE_ZONE_GENERATION_FALLBACK",
      "Could not get state boundaries, using state center only",
      {
        state: stateName,
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

  // Determine optimal grid spacing for state
  const gridSpacing = getOptimalStateGridSpacing(bounds, population);

  // Calculate total possible zones
  const totalPossibleZones = calculateTotalPossibleZones(bounds, gridSpacing);

  logger.info("STATE_ZONES_CONFIG", "Prepared batched state zone generation", {
    state: stateName,
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
    stateName,
    stateCode,
  };
}

/**
 * Generate a batch of state zones
 * @param {Object} zoneConfig - Configuration from createStateZones
 * @param {number} batchNumber - Which batch to generate (0-indexed)
 * @returns {Array} Array of zone objects for this batch
 */
export function generateStateZoneBatch(zoneConfig, batchNumber) {
  const { bounds, gridSpacing, batchSize, maxTotalZones, stateName, stateCode } =
    zoneConfig;

  if (!bounds || !gridSpacing) return [];

  const startIndex = batchNumber * batchSize;
  const endIndex = Math.min(startIndex + batchSize, maxTotalZones);

  if (startIndex >= maxTotalZones) return [];

  // Enable overlap for better coverage (especially for smaller states)
  const enableOverlap = gridSpacing <= 3; // Enable overlap for tighter grids

  const gridPoints = generateStateGridBatch(
    bounds,
    gridSpacing,
    startIndex,
    endIndex,
    enableOverlap
  );

  // Convert grid points to zone objects
  const zones = gridPoints.map((point) => ({
    type: point.type, // "grid" or "grid-overlap"
    stateName,
    stateCode,
    label: point.label,
    coords: { lat: point.lat, lng: point.lng },
  }));

  const primaryZones = zones.filter(z => z.type === "grid").length;
  const overlapZones = zones.filter(z => z.type === "grid-overlap").length;

  logger.info("STATE_ZONE_BATCH_GENERATED", "Generated state zone batch with overlap strategy", {
    state: stateName,
    batchNumber,
    totalZones: zones.length,
    primaryZones,
    overlapZones,
    zoneRange: `${startIndex}-${startIndex + primaryZones - 1}`,
    gridSpacingKm: gridSpacing,
  });

  return zones;
}
