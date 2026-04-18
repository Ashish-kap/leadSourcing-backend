import nodemailer from "nodemailer";

const sendEmail = async (options) => {
  // Create transporter
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST_ZOHO,
    port: process.env.EMAIL_PORT_ZOHO,
    auth: {
      user: process.env.EMAIL_USERNAME_ZOHO,
      pass: process.env.EMAIL_PASSWORD_ZOHO,
    },
  });

  // Define the email options
  const mailOptions = {
    from: process.env.MAIL_FROM_ZOHO,
    to: options.emailID,
    subject: options.subject,
    text: options.message,
    ...(options.html && { html: options.html }),
  };

  // Actually send the mail
  await transporter.sendMail(mailOptions);
};

export default sendEmail;
