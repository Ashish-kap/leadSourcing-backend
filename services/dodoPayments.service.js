import getDodoClient from "./dodoPaymentsClient.js";
import logger from "./logger.js";

export const ensureDodoCustomerForUser = async (user) => {
  if (!user) {
    return user;
  }

  if (user.dodoCustomerId) {
    return user;
  }

  const client = getDodoClient();
  const customerPayload = {
    email: user.emailID,
    name: user.name,
  };

  if (user.phoneNumber) {
    customerPayload.phone_number = user.phoneNumber;
  }

  let customer;
  try {
    customer = await client.customers.create(customerPayload);
    console.log(
      "Dodo Customer Creation Response:",
      JSON.stringify(customer, null, 2)
    );
  } catch (error) {
    const statusCode = error?.statusCode || error?.response?.status;
    const errorBody =
      error?.response?.data || error?.body || error?.message || error;

    logger.error(
      "DODO_CUSTOMER_CREATE_FAILED",
      "Failed to create Dodo customer",
      error
    );

    let errorMessage = "Failed to create Dodo customer";
    if (statusCode) {
      errorMessage += `: status ${statusCode}`;
    }
    if (errorBody && typeof errorBody !== "string") {
      try {
        errorMessage += ` ${JSON.stringify(errorBody)}`;
      } catch (_) {
        // ignore JSON stringify errors
      }
    } else if (errorBody) {
      errorMessage += ` ${errorBody}`;
    }

    throw new Error(errorMessage.trim());
  }

  // Extract customer and business IDs from the Dodo Payments API response
  // According to the API docs, the response has customer_id and business_id properties
  user.dodoCustomerId = customer.customer_id;
  user.dodoBusinessId = customer.business_id;

  console.log("Extracted IDs from Dodo API response:", {
    dodoCustomerId: user.dodoCustomerId,
    dodoBusinessId: user.dodoBusinessId,
    originalResponse: {
      customer_id: customer.customer_id,
      business_id: customer.business_id,
      created_at: customer.created_at,
    },
  });

  if (customer.created_at) {
    user.dodoCustomerCreatedAt = new Date(customer.created_at);
  }

  try {
    await user.save({ validateBeforeSave: false });
    console.log("User saved successfully with Dodo IDs");
  } catch (saveError) {
    logger.error(
      "USER_SAVE_FAILED",
      "Failed to save user with Dodo IDs",
      saveError
    );
    throw new Error("Failed to save user with Dodo customer information");
  }

  logger.info(
    "DODO_CUSTOMER_LINKED",
    "Linked Dodo customer " + user.dodoCustomerId + " to user " + user._id
  );

  return user;
};

export default ensureDodoCustomerForUser;
