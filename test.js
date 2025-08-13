import { City, State } from "country-state-city";

const getCitiesOfState = (countryCode, stateCode) =>
  City.getCitiesOfState(countryCode, stateCode);

const getStatesOfCountry = (countryCode) =>
  State.getStatesOfCountry(countryCode);

// Example: Get states of India
const states = getStatesOfCountry("IN");
console.log(
  "States of India:",
  states.map((s) => s.name)
);

// Example: Get cities of Maharashtra, India
const cities = getCitiesOfState("IN", "MH");
console.log(
  "Cities of Maharashtra:",
  cities.map((c) => c.name)
);
