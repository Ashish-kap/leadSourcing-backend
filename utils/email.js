import nodemailer from "nodemailer";

const sendEmail = async (options) => {
  // Create transporter
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    auth: {
      user: process.env.EMAIL_USERNAME,
      pass: process.env.EMAIL_PASSWORD,
    },
  });

  // Define the email options
  const mailOptions = {
    from: "srigbok sasn@gmail.com",
    to: options.emailID,
    subject: options.subject,
    text: options.message,
  };

  // Actually send the mail
  await transporter.sendMail(mailOptions);
};

export default sendEmail;
