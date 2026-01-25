import logger from "../logger.js";
import {
    getBoundingBox,
    generateGridBatch,
    calculateTotalPossibleZones,
    calculateAreaKm2
} from "./zoneGeneratorCommon.js";

/**
 * Get country boundaries from OpenStreetMap Nominatim API
 * @param {string} countryName - Name of the country
 * @param {string} countryCode - Country code
 * @returns {Object|null} Bounding box {north, south, east, west, center} or null
 */
export async function getCountryBoundingBox(countryName, countryCode) {
    return getBoundingBox(countryName, null, countryCode, "country");
}

/**
 * Generate a batch of grid points for country zones
 * @param {Object} bounds - {north, south, east, west}
 * @param {number} gridSpacingKm - Distance between grid points in kilometers
 * @param {number} startIndex - Starting zone index
 * @param {number} endIndex - Ending zone index (exclusive)
 * @param {boolean} enableOverlap - Whether to add overlapping zones for better coverage
 * @returns {Array} Array of {lat, lng, label, type} objects for this batch
 */
export function generateCountryGridBatch(
    bounds,
    gridSpacingKm,
    startIndex,
    endIndex,
    enableOverlap = true
) {
    return generateGridBatch(bounds, gridSpacingKm, startIndex, endIndex, enableOverlap, "country-zone");
}

/**
 * Determine optimal grid spacing based on country size
 * Countries are typically larger, so we use wider spacing by default
 * @param {Object} bounds - Country bounding box
 * @param {number|null} population - Country population (optional)
 * @returns {number} Recommended grid spacing in km
 */
export function getOptimalCountryGridSpacing(bounds, population = null) {
    if (!bounds) return 8; // default for countries

    const areaKm2 = calculateAreaKm2(bounds);

    // Smart spacing strategy: Vary spacing based on country size
    // For very small countries, use city-like spacing; for large countries, use wider spacing
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
 * Create zone generator for batched country scraping
 * Returns configuration for generating zones in batches
 * @param {string} countryName
 * @param {string} countryCode
 * @param {number|null} population
 * @param {boolean} enableDeepScrape - If false, only return country center
 * @param {number} batchSize - Zones per batch (default 50)
 * @param {number} maxTotalZones - Maximum total zones across all batches (default 3000)
 * @returns {Object} Zone generation configuration
 */
export async function createCountryZones(
    countryName,
    countryCode,
    population = null,
    enableDeepScrape = true,
    batchSize = 50,
    maxTotalZones = 3000
) {
    // Country center zone (always included)
    const centerZone = {
        type: "country",
        countryName,
        countryCode,
        label: "country-center",
        coords: null,
    };

    // If deep scrape disabled, return just the country center
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

    // Get country boundaries
    const bounds = await getCountryBoundingBox(countryName, countryCode);

    if (!bounds) {
        logger.warn(
            "COUNTRY_ZONE_GENERATION_FALLBACK",
            "Could not get country boundaries, using country center only",
            {
                country: countryName,
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

    // Determine optimal grid spacing for country
    const gridSpacing = getOptimalCountryGridSpacing(bounds, population);

    // Calculate total possible zones
    const totalPossibleZones = calculateTotalPossibleZones(bounds, gridSpacing);

    logger.info("COUNTRY_ZONES_CONFIG", "Prepared batched country zone generation", {
        country: countryName,
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
        countryName,
        countryCode,
    };
}

/**
 * Generate a batch of country zones
 * @param {Object} zoneConfig - Configuration from createCountryZones
 * @param {number} batchNumber - Which batch to generate (0-indexed)
 * @returns {Array} Array of zone objects for this batch
 */
export function generateCountryZoneBatch(zoneConfig, batchNumber) {
    const { bounds, gridSpacing, batchSize, maxTotalZones, countryName, countryCode } =
        zoneConfig;

    if (!bounds || !gridSpacing) return [];

    const startIndex = batchNumber * batchSize;
    const endIndex = Math.min(startIndex + batchSize, maxTotalZones);

    if (startIndex >= maxTotalZones) return [];

    // Enable overlap for better coverage (especially for smaller countries)
    const enableOverlap = gridSpacing <= 10; // Enable overlap for tighter grids

    const gridPoints = generateCountryGridBatch(
        bounds,
        gridSpacing,
        startIndex,
        endIndex,
        enableOverlap
    );

    // Convert grid points to zone objects
    const zones = gridPoints.map((point) => ({
        type: point.type, // "grid" or "grid-overlap"
        countryName,
        countryCode,
        label: point.label,
        coords: { lat: point.lat, lng: point.lng },
    }));

    const primaryZones = zones.filter(z => z.type === "grid").length;
    const overlapZones = zones.filter(z => z.type === "grid-overlap").length;

    logger.info("COUNTRY_ZONE_BATCH_GENERATED", "Generated country zone batch with overlap strategy", {
        country: countryName,
        batchNumber,
        totalZones: zones.length,
        primaryZones,
        overlapZones,
        zoneRange: `${startIndex}-${startIndex + primaryZones - 1}`,
        gridSpacingKm: gridSpacing,
    });

    return zones;
}
