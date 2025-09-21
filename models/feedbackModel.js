import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema(
  {
    // Basic identification
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "Feedback must belong to a user"],
      index: true,
    },

    // Feedback content
    message: {
      type: String,
      required: [true, "Feedback message is required"],
      trim: true,
      minlength: [10, "Feedback message must be at least 10 characters long"],
      maxlength: [1000, "Feedback message cannot exceed 1000 characters"],
    },

    // User satisfaction
    isSatisfied: {
      type: Boolean,
      required: [true, "Please indicate if you are satisfied with the result"],
      default: false,
    },
  },
  {
    timestamps: true, // This adds createdAt and updatedAt automatically
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better query performance
feedbackSchema.index({ userId: 1, createdAt: -1 });
feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ isSatisfied: 1, createdAt: -1 }); // For satisfaction analytics

// Virtual for user information (populated)
feedbackSchema.virtual("user", {
  ref: "User",
  localField: "userId",
  foreignField: "_id",
  justOne: true,
});

const Feedback = mongoose.model("Feedback", feedbackSchema);

export default Feedback;
