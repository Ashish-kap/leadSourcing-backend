import mongoose from "mongoose";

/**
 * Encodes a MongoDB ObjectId to an alphanumeric-only referral code
 * Uses URL-safe base64 and replaces special characters with alphanumeric ones
 * @param {String|mongoose.Types.ObjectId} userId - The user's ObjectId
 * @returns {String} Alphanumeric referral code (16-17 characters)
 */
export const encodeReferralCode = (userId) => {
  if (!userId) {
    return null;
  }

  // Convert to string if it's an ObjectId
  const userIdString =
    userId instanceof mongoose.Types.ObjectId
      ? userId.toString()
      : userId;

  // Convert hex string to Buffer, then to base64
  // ObjectId is 24 hex chars = 12 bytes
  const buffer = Buffer.from(userIdString, "hex");
  let base64Code = buffer.toString("base64");

  // Replace special characters with alphanumeric (reversible mapping)
  // This ensures only letters (a-z, A-Z) and numbers (0-9) are used
  // Map: + -> 0, / -> Z, = -> 9 (reversible mapping)
  base64Code = base64Code.replace(/\+/g, "0").replace(/\//g, "Z").replace(/=/g, "9");

  return base64Code;
};

/**
 * Decodes an alphanumeric referral code back to MongoDB ObjectId
 * @param {String} code - The alphanumeric encoded referral code
 * @returns {mongoose.Types.ObjectId|null} Decoded ObjectId or null if invalid
 */
export const decodeReferralCode = (code) => {
  if (!code || typeof code !== "string") {
    return null;
  }

  try {
    // Reverse the alphanumeric mapping: 0 -> +, Z -> /, 9 -> =
    let base64Code = code.replace(/0/g, "+").replace(/Z/g, "/").replace(/9/g, "=");

    // Decode base64 to Buffer, then to hex string
    const buffer = Buffer.from(base64Code, "base64");
    const hexString = buffer.toString("hex");

    // Validate it's a valid ObjectId format (24 hex characters)
    if (hexString.length !== 24) {
      return null;
    }

    // Validate it's a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(hexString)) {
      return null;
    }

    return new mongoose.Types.ObjectId(hexString);
  } catch (error) {
    // Invalid base64 or conversion error
    return null;
  }
};

