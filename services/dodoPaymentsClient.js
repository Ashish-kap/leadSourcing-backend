import dotenv from "dotenv";
import DodoPayments from "dodopayments";

dotenv.config();

let cachedClient;

export const getDodoClient = () => {
  if (!cachedClient) {
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;
    const baseURL = process.env.DODO_PAYMENTS_BASE_URL;
    const envSetting = process.env.DODO_PAYMENTS_ENVIRONMENT;

    const environment = "test_mode";
      // envSetting === "test"
      //   ? "test_mode"
      //   : envSetting === "live"
      //   ? "live_mode"
      //   : undefined;

    if (!apiKey) {
      throw new Error("Dodo Payments API key is not configured");
    }

    cachedClient = new DodoPayments({
      bearerToken: apiKey,
      // baseURL,
      // environment,
    });
  }

  return cachedClient;
};

export default getDodoClient;
