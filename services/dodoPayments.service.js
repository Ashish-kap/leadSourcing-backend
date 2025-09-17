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

  const customer = await client.customers.create(customerPayload);

  user.dodoCustomerId = customer.customer_id;
  user.dodoBusinessId = customer.business_id;

  if (customer.created_at) {
    user.dodoCustomerCreatedAt = new Date(customer.created_at);
  }

  await user.save({ validateBeforeSave: false });

  logger.info(
    "DODO_CUSTOMER_LINKED",
    "Linked Dodo customer " +
      customer.customer_id +
      " to user " +
      user._id
  );

  return user;
};

export default ensureDodoCustomerForUser;
