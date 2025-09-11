import cities from "all-the-cities";

function normalizeName(s = "") {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function key(iso2, adminOrState, city) {
  return [
    String(iso2 || "").toUpperCase(),
    normalizeName(adminOrState || ""),
    normalizeName(city || ""),
  ].join("|");
}

export function createPopulationResolverAllTheCities() {
  let INDEX = null;

  const setMax = (map, k, val) => {
    if (!k) return;
    const prev = map.get(k);
    if (prev == null || val > prev) map.set(k, val);
  };

  function loadIndex() {
    if (INDEX) return INDEX;
    const map = new Map();

    for (const c of cities) {
      // all-the-cities fields: name, country (ISO2), adminCode, population, loc...
      const iso2 = String(c.country || "").toUpperCase();
      const admin = String(c.adminCode || "");
      const name = String(c.name || "");
      const pop = Number(c.population) || 0;
      if (!iso2 || !name || pop <= 0) continue;

      // Index multiple variants to maximize match rate
      setMax(map, key(iso2, admin, name), pop); // with admin code
      setMax(map, key(iso2, "", name), pop); // fallback without admin
    }

    INDEX = map;
    return INDEX;
  }

  /**
   * Use like: getPopulationResolver({ iso2: 'US', adminCode: 'CA', city: 'San Diego' })
   * @returns number|null
   */
  return function getPopulationResolver({ iso2, adminCode = null, city }) {
    if (!iso2 || !city) return null;
    const idx = loadIndex();

    // Try with admin/state code first
    const v1 = idx.get(key(iso2, adminCode || "", city));
    if (v1 != null) return v1;

    // Fallback without admin/state
    const v2 = idx.get(key(iso2, "", city));
    return v2 ?? null;
  };
}
