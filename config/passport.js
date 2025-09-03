import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/userModel.js";

// Configure Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL || "/api/v1/users/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user already exists with this Google ID
        let existingUser = await User.findOne({ googleId: profile.id });

        if (existingUser) {
          return done(null, existingUser);
        }

        // Check if user exists with same email but different auth provider
        existingUser = await User.findOne({ emailID: profile.emails[0].value });

        if (existingUser) {
          // Link Google account to existing user
          existingUser.googleId = profile.id;
          existingUser.authProvider = "google";
          await existingUser.save({ validateBeforeSave: false });
          return done(null, existingUser);
        }

        // Create new user
        const newUser = new User({
          googleId: profile.id,
          name: profile.displayName,
          emailID: profile.emails[0].value,
          authProvider: "google",
          photo: profile.photos[0].value,
          plan: "freebie", // Default plan for OAuth users
          // No password required for OAuth users
          passwordConfirm: undefined,
        });

        await newUser.save({ validateBeforeSave: false });
        return done(null, newUser);
      } catch (error) {
        console.error("Google OAuth Error:", error);
        return done(error, null);
      }
    }
  )
);

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

export default passport;
