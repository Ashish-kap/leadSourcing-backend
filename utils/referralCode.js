import mongoose from "mongoose";

/**
 * Encodes a MongoDB ObjectId to a URL-safe referral code using base64url
 * Uses base64url encoding (RFC 4648) which replaces + with - and / with _
 * @param {String|mongoose.Types.ObjectId} userId - The user's ObjectId
 * @returns {String} URL-safe referral code (16 characters without padding)
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
  
  // Use base64url encoding: + -> -, / -> _, remove padding
  // This ensures no ambiguity since - and _ are NOT in base64 alphabet
  let base64Code = buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, ""); // Remove padding

  return base64Code;
};

/**
 * Decodes a base64url referral code back to MongoDB ObjectId
 * @param {String} code - The base64url encoded referral code
 * @returns {mongoose.Types.ObjectId|null} Decoded ObjectId or null if invalid
 */
export const decodeReferralCode = (code) => {
  if (!code || typeof code !== "string") {
    console.log("[REFERRAL_DECODE] Invalid input:", { code, type: typeof code });
    return null;
  }

  try {
    // Reverse base64url encoding: - -> +, _ -> /
    let base64Code = code.replace(/-/g, "+").replace(/_/g, "/");
    
    // Add padding if needed (base64 length must be multiple of 4)
    while (base64Code.length % 4) {
      base64Code += "=";
    }
    
    console.log("[REFERRAL_DECODE] Decoding process:", {
      originalCode: code,
      codeLength: code.length,
      base64Code: base64Code,
      base64Length: base64Code.length
    });

    // Decode base64 to Buffer, then to hex string
    const buffer = Buffer.from(base64Code, "base64");
    const hexString = buffer.toString("hex");

    console.log("[REFERRAL_DECODE] After base64 decode:", {
      hexString: hexString,
      hexLength: hexString.length,
      isValidLength: hexString.length === 24
    });

    // Validate it's a valid ObjectId format (24 hex characters)
    if (hexString.length !== 24) {
      console.log("[REFERRAL_DECODE] Invalid hex length:", {
        expected: 24,
        actual: hexString.length,
        hexString: hexString
      });
      return null;
    }

    // Validate it's a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(hexString)) {
      console.log("[REFERRAL_DECODE] Invalid ObjectId format:", {
        hexString: hexString,
        isValid: mongoose.Types.ObjectId.isValid(hexString)
      });
      return null;
    }

    const objectId = new mongoose.Types.ObjectId(hexString);
    console.log("[REFERRAL_DECODE] Successfully decoded:", {
      originalCode: code,
      decodedObjectId: objectId.toString()
    });
    
    return objectId;
  } catch (error) {
    // Invalid base64 or conversion error
    console.log("[REFERRAL_DECODE] Decode error:", {
      code: code,
      error: error.message,
      stack: error.stack
    });
    return null;
  }
};

