import express from "express";
import passport from "passport";
import rateLimit from "express-rate-limit";
import * as userController from "./../api/controllers/userController.js";
import * as authController from "./../api/controllers/authController.js";

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "fail",
    message: "Too many login attempts. Please try again in 15 minutes.",
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "fail",
    message:
      "Too many password reset requests. Please try again in 15 minutes.",
  },
});

router.post("/signup", authController.signup);
router.post("/login", loginLimiter, authController.login);
router.post("/logout", authController.logout);

// Google OAuth routes
router.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

router.get(
  "/auth/google/callback",
  passport.authenticate("google", { session: false }),
  authController.googleCallback
);

// Alternative API endpoint for mobile/token-based authentication
router.post("/auth/google/token", authController.googleTokenAuth);

router.post(
  "/forgotPassword",
  forgotPasswordLimiter,
  authController.forgotPassword
);
router.get("/resetPassword/:token", authController.redirectResetPassword);
router.patch("/resetPassword/:token", authController.resetPassword);
router.get("/verifyEmail/:token", authController.verifyEmail);
router.post("/resendVerificationEmail", authController.resendVerificationEmail);

// Protect all routes after this middleware
router.use(authController.protect);

router.patch("/updateMyPassword", authController.updatePassword);
router.get("/me", userController.getMeWithStats);
router.patch(
  "/updateMe",
  userController.uploadUserPhoto,
  userController.resizeUserPhoto,
  userController.updateMe
);
router.patch("/me/profile", userController.updateMyProfile);
router.delete("/deleteMe", userController.deleteMe);

router.use(authController.restrictTo("admin"));

router
  .route("/")
  .get(userController.getAllUsers)
  .post(userController.createUser);

router
  .route("/:id")
  .get(userController.getUser)
  .patch(userController.updateUser)
  .delete(userController.deleteUser);

export default router;
