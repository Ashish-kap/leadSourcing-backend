import axios from "axios";
import logger from "../logger.js";

/**
 * Generic function to get bounding box from OpenStreetMap Nominatim API
 * @param {string} locationName - Name of the location (city, state, etc.)
 * @param {string} stateCode - Optional state code
 * @param {string} countryCode - Country code
 * @param {string} locationType - Type of location for logging (e.g., "city", "state")
 * @returns {Object|null} Bounding box {north, south, east, west, center} or null
 */
export async function getBoundingBox(locationName, stateCode, countryCode, locationType = "location") {
  try {
    // Build search query
    const searchParts = [locationName];
    if (stateCode) searchParts.push(stateCode);
    if (countryCode) searchParts.push(countryCode);

    const query = searchParts.join(", ");

    logger.info("GEOCODING_REQUEST", `Fetching ${locationType} boundaries`, {
      [locationType]: locationName,
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
        locationType,
      });
      return null;
    }

    const result = response.data[0];

    // Nominatim returns boundingbox as [south, north, west, east]
    if (!result.boundingbox || result.boundingbox.length !== 4) {
      logger.warn("GEOCODING_NO_BBOX", "No bounding box in result", { 
        query, 
        locationType 
      });
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

    logger.info("GEOCODING_SUCCESS", `Retrieved ${locationType} boundaries`, {
      [locationType]: locationName,
      bounds,
    });

    return bounds;
  } catch (error) {
    logger.error("GEOCODING_ERROR", `Error fetching ${locationType} boundaries`, {
      [locationType]: locationName,
      error: error.message,
    });
    return null;
  }
}

/**
 * Generate a batch of grid points for a specific range with overlap strategy
 * Generic function that works for both cities and states
 * @param {Object} bounds - {north, south, east, west}
 * @param {number} gridSpacingKm - Distance between grid points in kilometers
 * @param {number} startIndex - Starting zone index
 * @param {number} endIndex - Ending zone index (exclusive)
 * @param {boolean} enableOverlap - Whether to add overlapping zones for better coverage
 * @param {string} zonePrefix - Prefix for zone labels (e.g., "zone" or "state-zone")
 * @returns {Array} Array of {lat, lng, label, type} objects for this batch
 */
export function generateGridBatch(
  bounds,
  gridSpacingKm,
  startIndex,
  endIndex,
  enableOverlap = true,
  zonePrefix = "zone"
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
        // Primary zone
        points.push({
          lat: parseFloat(lat.toFixed(6)),
          lng: parseFloat(lng.toFixed(6)),
          label: `${zonePrefix}-${gridIndex}`,
          type: "grid",
        });

        // Add overlapping zones for better coverage
        if (enableOverlap) {
          const overlapDistance = gridSpacingKm * 0.3; // 30% overlap
          const latOverlap = overlapDistance / 111;
          const lngOverlap = overlapDistance / (111 * Math.cos((avgLat * Math.PI) / 180));

          // Add 4 overlapping zones around the primary zone
          const overlapOffsets = [
            { lat: latOverlap, lng: 0 }, // North
            { lat: -latOverlap, lng: 0 }, // South
            { lat: 0, lng: lngOverlap }, // East
            { lat: 0, lng: -lngOverlap }, // West
          ];

          overlapOffsets.forEach((offset, idx) => {
            const overlapLat = lat + offset.lat;
            const overlapLng = lng + offset.lng;
            
            // Only add if within bounds
            if (overlapLat >= south && overlapLat <= north && 
                overlapLng >= west && overlapLng <= east) {
              points.push({
                lat: parseFloat(overlapLat.toFixed(6)),
                lng: parseFloat(overlapLng.toFixed(6)),
                label: `${zonePrefix}-${gridIndex}-overlap-${idx + 1}`,
                type: "grid-overlap",
              });
            }
          });
        }
      }
      gridIndex++;

      // Stop if we've passed the end index
      if (gridIndex >= endIndex) break outerLoop;
    }
  }

  return points;
}

/**
 * Calculate total possible zones for a given area
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
 * Calculate approximate area in km² from bounding box
 * @param {Object} bounds - {north, south, east, west}
 * @returns {number} Area in square kilometers
 */
export function calculateAreaKm2(bounds) {
  if (!bounds) return 0;

  const { north, south, east, west } = bounds;
  const latDiff = north - south;
  const lngDiff = east - west;
  const avgLat = (north + south) / 2;

  // Approximate area in km²
  return latDiff * 111 * lngDiff * 111 * Math.cos((avgLat * Math.PI) / 180);
}
