import DodoPayments from "dodopayments";

let cachedClient;

export const getDodoClient = () => {
  if (!cachedClient) {
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;

    if (!apiKey) {
      throw new Error("Dodo Payments API key is not configured");
    }

    cachedClient = new DodoPayments({
      bearerToken: apiKey,
    });
  }

  return cachedClient;
};

export default getDodoClient;
