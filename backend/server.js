import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import crypto from "crypto";
import 'dotenv/config';
import { cropPlanRules } from './recommendationData.js';
import cron from 'node-cron';
import { toAcres } from "./shared/units.js";
import { listCrops } from "./shared/crops.js";
import { buildCropPlan, isSameCrop } from "./services/cropPlan.js";
import { checkCropDeadlines, runWeatherAlertJob, IST } from "./services/notifications.js";
import { requireFarmer } from "./middleware/farmerIdentity.js";
import axios from 'axios';
import landRoutes from "./features/loanAssistant/routes/landRoutes.js";
import loanRoutes from "./features/loanAssistant/routes/loanRoutes.js";
import schemeRoutes from "./features/loanAssistant/routes/schemeRoutes.js";
import mandiRoutes from "./features/loanAssistant/routes/mandiRoutes.js";
import irrigationRoutes from "./features/loanAssistant/routes/irrigationRoutes.js";
import farmerQueryRoutes from "./features/loanAssistant/routes/farmerQueryRoutes.js";
import farmerProfileRoutes from "./features/loanAssistant/routes/farmerProfileRoutes.js";
import schemeEligibilityRoutes from "./features/loanAssistant/routes/schemeEligibilityRoutes.js";
import adminRoutes from "./features/loanAssistant/routes/adminRoutes.js";
import {
    validateSignup,
    validateLogin,
    validateForgotPassword,
    validateResetPassword,
    validateProfileUpdate,
    validateUserIdParam,
    validateNotificationsUpdate,
    validateActivity,
    validateCropPlan,
    validateUserCropCreate,
    validateUserCropUpdate
} from "./middleware/coreValidators.js";

const app = express();
const API_PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5500", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true
}));

// Fail fast when MongoDB is down. Without this, mongoose buffers each query
// and only rejects after 10s, so the UI hangs and then surfaces a raw internal
// message ("Operation `users.findOne()` buffering timed out") to the user.
// The farmer Q&A routes are exempt: they degrade gracefully without a database.
const DB_OPTIONAL_PREFIXES = ["/api/farmers", "/api/weather"];

app.use("/api", (req, res, next) => {
    if (mongoose.connection.readyState === 1) return next();
    if (DB_OPTIONAL_PREFIXES.some((p) => req.originalUrl.startsWith(p))) return next();

    return res.status(503).json({
        error: "The database is unavailable, so this feature can't be used right now."
    });
});

app.use("/api/lands", landRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/loans", schemeRoutes);
app.use("/api/lands", mandiRoutes);
app.use("/api/lands", irrigationRoutes);
app.use("/api/farmers", farmerQueryRoutes);
app.use("/api/farmer-profiles", farmerProfileRoutes);
app.use("/api/schemes", schemeEligibilityRoutes);
app.use("/api/admin", adminRoutes);

// Connect to MongoDB. Honours MONGO_URI (e.g. an Atlas connection string) and
// falls back to the local dev database, so deploying elsewhere is a config change
// rather than a code change.
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mydb";

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log(`✅ MongoDB Connected (${MONGO_URI.startsWith("mongodb+srv") ? "remote" : "local"})`);
    })
    .catch(err => {
        console.error("❌ MongoDB connection error:", err.message);
        // EBADNAME on an SRV lookup almost always means the connection string
        // still has an unsubstituted <placeholder> rather than a real host.
        if (err.code === 'EBADNAME' || /<[a-z_]+>/i.test(MONGO_URI)) {
            console.error(
                "   MONGO_URI still contains a placeholder (e.g. <cluster>).\n" +
                "   Paste the real connection string from MongoDB Atlas:\n" +
                "   Atlas → your cluster → Connect → Drivers.\n" +
                "   Features that need the database (login, land records, loans) will not work until then."
            );
        }
    });

// Email configuration for notifications
const notificationTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// User Schema & Model
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    location: { type: String },
    createdAt: { type: Date, default: Date.now },
    resetToken: String,
    resetTokenExpiry: Date,
    notificationPreferences: {
        emailNotifications: { type: Boolean, default: true },
        deadlineReminders: { type: Boolean, default: true }
    },
    // When each kind of weather alert was last emailed, so each goes out at most once per IST day.
    weatherAlertsSent: {
        heavy_rain: Date,
        frost: Date,
        strong_wind: Date,
        extreme_heat: Date
    }
});

// Hash password before saving
userSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (err) {
        next(err);
    }
});

const User = mongoose.model("User", userSchema);

// Dashboard Schema & Model
const dashboardSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    activities: [String],
    lastLogin: Date
});

const Dashboard = mongoose.model("Dashboard", dashboardSchema);

// Crop Schema & Model
const cropSchema = new mongoose.Schema({
    id: Number,
    name: String,
    type: String,
    image: String,
    season: String,
    soil: String,
    temperature: String,
    water: String,
    germination: String,
    maturity: String,
    harvest: String,
    overview: String,
    care: String
});

const Crop = mongoose.model("Crop", cropSchema);

// User-specific Crop Calendar Schema
const userCropSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "User", 
        required: true 
    },
    name: { type: String, required: true },
    type: { type: String, required: true },
    plantDate: { type: Date, required: true },
    growDuration: { type: Number, required: true },
    harvestDuration: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now },
    notificationsSent: {
        threeDay: { type: Boolean, default: false },
        oneDay: { type: Boolean, default: false },
        harvestDay: { type: Boolean, default: false }
    }
});

const UserCrop = mongoose.model("UserCrop", userCropSchema);

// ========================================================
// NOTIFICATIONS
// ========================================================
// Harvest reminders and weather alerts live in services/notifications.js (so they can be tested
// without a database or a mail server). Only the one-off "crop added" confirmation stays here.

// Function to send confirmation email when crop is added
async function sendCropAddedConfirmation(userEmail, crop, userName) {
    try {
        const harvestDate = new Date(crop.plantDate);
        harvestDate.setDate(harvestDate.getDate() + crop.growDuration);
        
        const mailOptions = {
            from: `"Crop Calendar Notifications" <${process.env.GMAIL_USER}>`,
            to: userEmail,
            subject: `✅ Crop Added: ${crop.name}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #0e7a5a, #0e3b2e); color: white; padding: 20px; text-align: center;">
                        <h1>🌱 Crop Successfully Added</h1>
                    </div>
                    <div style="background: #f8fbf9; padding: 20px;">
                        <p>Hello ${userName || 'Farmer'},</p>
                        <p>Your crop <strong>${crop.name}</strong> has been successfully added to your calendar.</p>
                        
                        <div style="background: white; padding: 15px; margin: 15px 0; border-radius: 8px; border-left: 4px solid #0e7a5a;">
                            <h3>Crop Details:</h3>
                            <p><strong>Name:</strong> ${crop.name}</p>
                            <p><strong>Type:</strong> ${crop.type}</p>
                            <p><strong>Planting Date:</strong> ${new Date(crop.plantDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                            <p><strong>Growth Duration:</strong> ${crop.growDuration} days</p>
                            <p><strong>Expected Harvest:</strong> ${harvestDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                        </div>
                        
                        <p>You will receive automatic reminders 3 days before, 1 day before, and on the day of harvest.</p>
                        <p>Happy farming! 🌾</p>
                    </div>
                </div>
            `
        };

        await notificationTransporter.sendMail(mailOptions);
        console.log(`✅ Crop added confirmation sent to ${userEmail}`);
    } catch (error) {
        console.error('❌ Failed to send crop added confirmation:', error);
    }
}

// Harvest reminders run daily at 8:00 AM India time, whatever time zone the server is in.
// A missed run is caught up on the next one (see harvestMilestone), so a restart at 8:00 loses nothing.
cron.schedule('0 8 * * *', async () => {
    if (mongoose.connection.readyState !== 1) {
        console.warn('⏭️  Skipping deadline check — MongoDB is not connected.');
        return;
    }
    console.log('\n=== Running scheduled crop deadline check ===');
    try {
        await checkCropDeadlines();
    } catch (error) {
        console.error('❌ Error checking crop deadlines:', error.message);
    }
}, { timezone: IST });

// ========================================================
// NOTIFICATION API ROUTES
// ========================================================

// Manual trigger endpoint for testing
app.post("/api/trigger-deadline-check", async (req, res) => {
    try {
        const summary = await checkCropDeadlines();
        res.json({ message: "Deadline check completed successfully", summary });
    } catch (error) {
        res.status(500).json({ error: "Failed to trigger deadline check" });
    }
});

// Update user notification preferences
app.put("/api/users/:id/notifications", validateNotificationsUpdate, async (req, res) => {
    try {
        const { emailNotifications, deadlineReminders } = req.body;
        const user = await User.findByIdAndUpdate(
            req.params.id,
            { 
                notificationPreferences: {
                    emailNotifications,
                    deadlineReminders
                }
            },
            { new: true }
        );
        
        if (!user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, notificationPreferences: user.notificationPreferences });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get user notification preferences
app.get("/api/users/:id/notifications", validateUserIdParam, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });
        
        res.json({ 
            notificationPreferences: user.notificationPreferences || {
                emailNotifications: true,
                deadlineReminders: true
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================================================
// USER-CROP API ROUTES (UPDATED WITH NOTIFICATIONS)
// ========================================================

// 1. POST: Add a new crop for a user
app.post("/api/user-crops", requireFarmer("body", "userId"), validateUserCropCreate, async (req, res) => {
    try {
        const { userId, name, type, plantDate, growDuration, harvestDuration } = req.body;
        
        // Basic validation
        if (!userId || !name || !type || !plantDate || !growDuration || !harvestDuration) {
            return res.status(400).json({ error: "Missing required crop fields." });
        }

        const newUserCrop = new UserCrop({
            userId,
            name,
            type,
            plantDate: new Date(plantDate),
            growDuration: parseInt(growDuration),
            harvestDuration: parseInt(harvestDuration),
            notificationsSent: {
                threeDay: false,
                oneDay: false,
                harvestDay: false
            }
        });

        const savedCrop = await newUserCrop.save();
        console.log(`✅ Crop added for user ${userId}: ${name}`);
        
        // Send immediate confirmation email
        try {
            const user = await User.findById(userId);
            if (user && user.notificationPreferences?.emailNotifications) {
                await sendCropAddedConfirmation(user.email, savedCrop, user.name);
            }
        } catch (emailError) {
            console.error('Failed to send confirmation email:', emailError);
        }
        
        res.status(201).json(savedCrop);
    } catch (err) {
        console.error("🔥 Error adding user crop:", err.message);
        res.status(500).json({ error: "Failed to add crop to database." });
    }
});

// 2. GET: Retrieve all crops for a specific user
app.get("/api/user-crops/:userId", requireFarmer("params", "userId"), async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Ensure the ID is a valid MongoDB ObjectId
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ error: "Invalid User ID format." });
        }

        const userCrops = await UserCrop.find({ userId }).sort({ plantDate: 1 });
        console.log(`Fetched ${userCrops.length} crops for user ${userId}.`);
        res.json(userCrops);
    } catch (err) {
        console.error("🔥 Error fetching user crops:", err.message);
        res.status(500).json({ error: "Failed to retrieve crops." });
    }
});

// 3. DELETE: Delete a crop by its ID
app.delete("/api/user-crops/:id", async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid Crop ID format." });
        }

        const result = await UserCrop.findByIdAndDelete(id);

        if (!result) {
            return res.status(404).json({ message: "Crop not found." });
        }

        console.log(`🗑️ Crop deleted: ${id}`);
        res.json({ message: "Crop deleted successfully." });
    } catch (err) {
        console.error("🔥 Error deleting user crop:", err.message);
        res.status(500).json({ error: "Failed to delete crop." });
    }
});

// 4. PUT: Update an existing crop
app.put("/api/user-crops/:id", validateUserCropUpdate, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, type, plantDate, growDuration, harvestDuration } = req.body;
        
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: "Invalid Crop ID format." });
        }
        
        const updatedCrop = await UserCrop.findByIdAndUpdate(
            id,
            { 
                name, 
                type, 
                plantDate, 
                growDuration, 
                harvestDuration,
                // Reset notifications when crop is updated
                notificationsSent: {
                    threeDay: false,
                    oneDay: false,
                    harvestDay: false
                }
            },
            { new: true, runValidators: true }
        );

        if (!updatedCrop) {
            return res.status(404).json({ message: "Crop not found." });
        }

        console.log(`✅ Crop updated: ${id}`);
        res.json(updatedCrop);
    } catch (err) {
        console.error("🔥 Error updating user crop:", err.message);
        res.status(500).json({ error: "Failed to update crop due to server error." });
    }
});

// ========================================================
// EXISTING ROUTES (KEEP ALL YOUR EXISTING CODE BELOW)
// ========================================================

// Function to safely insert all rules from recommendationData.js
async function importAllData() {
    const CropPlanData = mongoose.model("CropPlanData");
    try {
        const count = await CropPlanData.countDocuments();
        if (count < cropPlanRules.length) { 
            console.log(`ℹ️ DB currently has ${count} records. Inserting ${cropPlanRules.length} new rules...`);
            const results = await CropPlanData.insertMany(cropPlanRules, { ordered: false });
            console.log(`✅ Successfully inserted ${results.length} new crop recommendation rules.`);
        } else {
            console.log(`ℹ️ Crop Plan Data is up-to-date with ${count} records. Skipping insertion.`);
        }
    } catch (err) {
        console.error("❌ ERROR DURING DATA IMPORT:", err.message);
    }
}

// Existing API route to get all generic crops
app.get("/api/crops", async (req, res) => {
    try {
        const crops = await Crop.find();
        res.json(crops);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Routes (Signup, Login, etc.)
app.get("/", (req, res) => {
    res.send("Backend is running");
});

app.get("/api/users", async (req, res) => {
    try {
        const users = await User.find();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/users", validateSignup, async (req, res) => {
    try {
        const { name, email, password, location } = req.body; 
        const newUser = new User({ name, email, password, location }); 
        await newUser.save();
        res.json({ message: "Signup successful", user: newUser });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ error: "An account with this email already exists." });
        }
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/login", validateLogin, async (req, res) => {
    try {
        console.log("➡️ Login attempt:", req.body);
        const { email, password } = req.body;
        const user = await User.findOne({ email });

        if (!user) {
            console.log("❌ User not found:", email);
            return res.status(400).json({ error: "User not found" });
        }

        const isMatch = await bcrypt.compare(password.trim(), user.password);

        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials" });
        }

        await Dashboard.findOneAndUpdate(
            { userId: user._id },
            { lastLogin: new Date() },
            { upsert: true }
        );

        console.log("✅ Login successful for:", user.email);

        res.json({
            success: true,
            message: "Login successful",
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                location: user.location
            }
        });
    } catch (err) {
        console.error("🔥 Login error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/activity", requireFarmer("body", "userId"), validateActivity, async (req, res) => {
    try {
        const { userId, activity } = req.body;
        await Dashboard.findOneAndUpdate(
            { userId },
            { $push: { activities: activity } },
            { upsert: true }
        );
        res.json({ message: "Activity saved!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/forgot-password", validateForgotPassword, async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: "User not found" });

        const token = crypto.randomBytes(32).toString("hex");
        user.resetToken = token;
        user.resetTokenExpiry = Date.now() + 15 * 60 * 1000;
        await user.save();

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.GMAIL_USER,
                pass: process.env.GMAIL_PASS
            }
        });

        const resetLink = `http://localhost:3000/reset?token=${token}`;

        await transporter.sendMail({
            from: `"The Green Guide" <${process.env.GMAIL_USER}>`,
            to: user.email,
            subject: "Password Reset Request",
            html: `<p>Click the link below to reset your password (valid 15 minutes):</p>
                  <a href="${resetLink}">${resetLink}</a>`
        });

        res.json({ message: "✅ Reset link sent to your email" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/reset-password", validateResetPassword, async (req, res) => {
    const { token, password } = req.body;
    try {
        const user = await User.findOne({
            resetToken: token,
            resetTokenExpiry: { $gt: Date.now() }
        });

        if (!user) return res.status(400).json({ error: "Invalid or expired token" });

        user.password = password;
        user.resetToken = undefined;
        user.resetTokenExpiry = undefined;
        await user.save();

        res.json({ message: "✅ Password updated successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Existing Crop Plan Data Schema and API
const cropPlanDataSchema = new mongoose.Schema({
    crop_name: { type: String, required: true, index: true },
    soil_type: { type: String, required: true },
    cultivation_method: { type: String, required: true },
    growth_stage: { type: String },
    fertilizer_type: { type: String },
    fertilizer_quantity: { type: String },
    pest_name: { type: String },
    management_type: { type: String },
    input_recommendation: { type: String },
    application_rate: { type: String },
    unit_of_measure: { type: String },
    estimated_unit_price_usd: { type: Number },
});

cropPlanDataSchema.index({ crop_name: 1, soil_type: 1, cultivation_method: 1 });
const CropPlanData = mongoose.model("CropPlanData", cropPlanDataSchema);

// Land area is in ACRES (as in land records) unless `unit: "hectares"` is sent. The recommendation
// data is per hectare and priced in USD; services/cropPlan.js converts both at this edge.
app.post("/api/crop-plan", validateCropPlan, async (req, res) => {
    try {
        const crop_name_clean = req.body.crop_name.trim();
        const soil_type_clean = req.body.soil_type.trim();
        const cultivation_method_clean = req.body.cultivation_method.trim();
        const acres = toAcres(req.body.land_area, req.body.unit ?? "acres");

        console.log(`➡️ Generating plan for: ${crop_name_clean}, ${soil_type_clean}, ${cultivation_method_clean} on ${acres.toFixed(2)} acres`);

        const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidates = await CropPlanData.find({
            soil_type: new RegExp(`^${escape(soil_type_clean)}$`, 'i'),
            cultivation_method: new RegExp(`^${escape(cultivation_method_clean)}$`, 'i')
        });
        // "paddy" finds the plan stored under "Rice", "baingan" the one under "Brinjal (Eggplant)"
        const recommendations = candidates.filter((rec) => isSameCrop(rec.crop_name, crop_name_clean));

        if (recommendations.length === 0) {
            return res.status(404).json({ message: "No specific plan found for these conditions. Returning general advice." });
        }

        const plan = buildCropPlan(recommendations, { acres });
        console.log(`✅ Plan generated. Total estimated cost: ₹${plan.totalCostINR}`);

        res.json({ success: true, plan });
    } catch (err) {
        console.error("🔥 Error generating crop plan:", err.message);
        res.status(500).json({ error: "Failed to generate plan due to a server error." });
    }
});

// Every crop the app knows, for pickers (the calendar uses it to suggest names and pre-fill the cycle length).
app.get("/api/crops/catalog", (req, res) => res.json(listCrops()));

app.get("/api/crops/unique", async (req, res) => {
    try {
        const uniqueCrops = await CropPlanData.distinct("crop_name");
        res.json(uniqueCrops.sort());
    } catch (err) {
        console.error("🔥 Error fetching unique crop names:", err.message);
        res.status(500).json({ error: "Failed to fetch crop list." });
    }
});

// Weather alerts: the hourly job and its rules are in services/notifications.js and
// services/weatherAlerts.js. Defaults to once an hour; each kind of alert still goes to a person
// at most once per day. Set WEATHER_CRON to '* * * * *' to exercise it every minute while testing.
const WEATHER_CRON = process.env.WEATHER_CRON || '0 * * * *';

cron.schedule(WEATHER_CRON, async () => {
    // mongoose buffers queries while disconnected and only fails after a 10s
    // timeout, so without this guard a misconfigured MONGO_URI produces a
    // recurring wall of identical errors. readyState 1 === connected.
    if (mongoose.connection.readyState !== 1) {
        console.warn('⏭️  Skipping weather check — MongoDB is not connected.');
        return;
    }
    console.log('\n--- Running weather check ---');
    try {
        await runWeatherAlertJob();
    } catch (error) {
        console.error("Error running the weather alert job:", error.message);
    }
}, { timezone: IST });

// Weather proxy. The browser used to call OpenWeatherMap directly with the API
// key embedded in weather.html, where anyone could read it. These routes keep the
// key on the server and pass OpenWeather's JSON (including its error bodies)
// straight through, so the page's parsing is unchanged.
async function proxyOpenWeather(res, endpoint, params) {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ cod: 503, message: "Weather service is not configured on this server." });
    }
    try {
        const response = await axios.get(`https://api.openweathermap.org/data/2.5/${endpoint}`, {
            params: { ...params, appid: apiKey, units: "metric" },
            timeout: 10000,
            validateStatus: () => true
        });
        res.status(response.status).json(response.data);
    } catch (err) {
        console.error(`❌ OpenWeather ${endpoint} request failed:`, err.message);
        res.status(502).json({ cod: 502, message: "Could not reach the weather service." });
    }
}

app.get("/api/weather/current", (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ cod: 400, message: "q (city name) is required" });
    return proxyOpenWeather(res, "weather", { q });
});

app.get("/api/weather/forecast", (req, res) => {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return res.status(400).json({ cod: 400, message: "lat and lon must be numbers" });
    }
    return proxyOpenWeather(res, "forecast", { lat, lon });
});

// Update user profile
app.put("/api/users/:id", validateProfileUpdate, async (req, res) => {
    try {
        const { name, email } = req.body;
        const user = await User.findByIdAndUpdate(req.params.id, { name, email }, { new: true });
        if(!user) return res.status(404).json({ error: "User not found" });
        res.json({ success: true, user });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Start Server
app.listen(API_PORT, () => {
    console.log(`🚀 Server running on http://localhost:${API_PORT}`);
    console.log(
        WEATHER_CRON === '* * * * *'
            ? `⚠️ TEST MODE: Weather alerts are scheduled to run EVERY MINUTE.`
            : `✅ Weather alerts are scheduled (${WEATHER_CRON})`
    );
    console.log(`✅ Deadline notifications are scheduled to run daily at 8:00 AM IST`);
});