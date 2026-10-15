// Validation for the core routes in server.js (accounts, crop calendar, crop plan).
// Helpers and conventions: ./validation.js.
//
// Rules are deliberately no stricter than what the pages already enforce, so they
// reject malformed requests (missing fields, wrong types, bad ids) without turning
// away anything the app itself sends. The signup password rule (8+ characters)
// matches the signup page.

import { body } from "express-validator";
import {
  amount,
  dateField,
  integer,
  objectIdBody,
  objectIdParam,
  optionalEmail,
  optionalText,
  requiredBoolean,
  requiredEmail,
  requiredPassword,
  requiredText,
  validate,
} from "./validation.js";

// ---------------------------------------------------------------- accounts

export const validateSignup = validate(
  requiredText("name", "Name"),
  requiredEmail("email", "Email"),
  requiredPassword("password", "Password", { min: 8 }),
  optionalText("location", "Location")
);

// Login only checks that something sensible was sent; whether it is right is the
// handler's job. (No email-format rule, so older accounts keep working.)
export const validateLogin = validate(
  requiredText("email", "Email", 254),
  requiredPassword("password", "Password")
);

export const validateForgotPassword = validate(requiredEmail("email", "Email"));

export const validateResetPassword = validate(
  requiredText("token", "Reset token", 200),
  requiredPassword("password", "New password", { min: 8 })
);

export const validateProfileUpdate = validate(
  objectIdParam("id", "User"),
  optionalText("name", "Name"),
  optionalEmail("email", "Email")
);

export const validateUserIdParam = validate(objectIdParam("id", "User"));

export const validateNotificationsUpdate = validate(
  objectIdParam("id", "User"),
  requiredBoolean("emailNotifications", "Email notifications"),
  requiredBoolean("deadlineReminders", "Deadline reminders")
);

export const validateActivity = validate(
  objectIdBody("userId", "User"),
  requiredText("activity", "Activity", 500)
);

// ---------------------------------------------------------------- crops

// land_area is in ACRES (like land records) unless `unit: "hectares"` is sent.
export const validateCropPlan = validate(
  requiredText("crop_name", "Crop"),
  requiredText("soil_type", "Soil type"),
  requiredText("cultivation_method", "Cultivation method"),
  amount("land_area", "Land area", { required: true, positive: true }),
  body("unit").optional({ values: "null" }).isIn(["acres", "hectares"]).withMessage('Unit must be "acres" or "hectares"')
);

export const validateUserCropCreate = validate(
  objectIdBody("userId", "User"),
  requiredText("name", "Crop name"),
  requiredText("type", "Crop type"),
  dateField("plantDate", "Plant date"),
  integer("growDuration", "Growth duration (days)"),
  integer("harvestDuration", "Harvest duration (days)")
);

// A crop edit sends the whole form, but each field is checked only if present.
export const validateUserCropUpdate = validate(
  objectIdParam("id", "Crop"),
  optionalText("name", "Crop name"),
  optionalText("type", "Crop type"),
  dateField("plantDate", "Plant date", { required: false }),
  integer("growDuration", "Growth duration (days)", { required: false }),
  integer("harvestDuration", "Harvest duration (days)", { required: false })
);
