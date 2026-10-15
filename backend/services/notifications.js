// Scheduled email notifications: harvest reminders and weather alerts.
//
// Moved out of server.js so the decisions can be tested without a database or a mail
// server. What it fixes, each confirmed in the old code:
//  - Weather alerts ignored notificationPreferences and re-sent the same alert every hour.
//    They now respect the opt-out and send each alert type at most once per IST day.
//  - They looked only at current conditions; they now look at the next 24 hours too, and the
//    city is sent URL-encoded (via weatherClient).
//  - Harvest reminders fired only on EXACTLY 3, 1 or 0 days out, so a missed run lost the
//    reminder forever. They now catch up (<= 3 days), sending the most urgent unsent one.
//  - A reminder was marked "sent" even when the email failed. It is now marked only on success.
//  - Users with no saved preferences were skipped entirely; unset now means the default (on).
//  - Days were counted in the server's time zone; everything is now IST (Asia/Kolkata).
//  - harvestDuration was stored and never used; it now defines the harvest window.

import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { fetchCurrentWeather, fetchForecast } from "../features/loanAssistant/services/weatherClient.js";
import { istDay, IST, detectWeatherAlerts, newAlertsOnly } from "./weatherAlerts.js";

export { IST };

const DAY_MS = 86400000;

// ---------------------------------------------------------------- shared helpers

let transporter = null;
const defaultSendMail = (options) => {
  transporter ??= nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS } });
  return transporter.sendMail(options);
};

const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** An IST day number as a readable date. */
const formatDay = (day) =>
  new Date(day * DAY_MS).toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/**
 * Does this user want this kind of email? `emailNotifications` is the master switch;
 * `deadlineReminders` is the extra one for harvest reminders. A setting that was never saved
 * means the default, which is on (the schema's default), not "off".
 */
export function wantsEmail(user, kind) {
  const prefs = user?.notificationPreferences;
  if (prefs?.emailNotifications === false) return false;
  if (kind === "harvest" && prefs?.deadlineReminders === false) return false;
  return true;
}

// ---------------------------------------------------------------- harvest reminders


/**
 * What to do about one crop today.
 *
 * Harvest starts `growDuration` days after planting and runs for `harvestDuration` days (the
 * harvest window). A milestone is due once harvest is within its distance: 3 days, 1 day, or
 * today. If runs were missed, the most urgent unsent milestone is sent ONCE and the less
 * urgent ones are marked sent too, so the farmer gets one email, not a burst. Once the whole
 * window has passed there is nothing useful to say, so those milestones are closed silently
 * (this is also what stops a crop added with an old planting date from emailing about the past).
 *
 * @returns {{ send: string|null, markSent: string[], daysUntilHarvest: number, daysLate: number,
 *             harvestStartDay: number, harvestEndDay: number, expired?: boolean }}
 */
export function harvestMilestone({ plantDate, growDuration, harvestDuration, sent = {}, now = new Date() }) {
  const harvestStartDay = istDay(plantDate) + Number(growDuration);
  const harvestEndDay = harvestStartDay + Math.max(1, Number(harvestDuration) || 1) - 1;
  const daysUntilHarvest = harvestStartDay - istDay(now);
  const base = { daysUntilHarvest, daysLate: Math.max(0, -daysUntilHarvest), harvestStartDay, harvestEndDay };

  const due = [];
  if (daysUntilHarvest <= 0) due.push("harvestDay");
  if (daysUntilHarvest <= 1) due.push("oneDay");
  if (daysUntilHarvest <= 3) due.push("threeDay");

  const unsent = due.filter((m) => !sent[m]);
  if (unsent.length === 0) return { ...base, send: null, markSent: [] };

  if (istDay(now) > harvestEndDay) return { ...base, send: null, markSent: unsent, expired: true };

  // The most urgent milestone was already sent: the rest are redundant, close them quietly.
  if (sent[due[0]]) return { ...base, send: null, markSent: unsent };

  return { ...base, send: unsent[0], markSent: unsent };
}

function harvestEmail(user, crop, m) {
  const name = escapeHtml(crop.name);
  const when = m.daysUntilHarvest <= 0 ? "today" : m.daysUntilHarvest === 1 ? "tomorrow" : `in ${m.daysUntilHarvest} days`;
  const window = `${formatDay(m.harvestStartDay)} to ${formatDay(m.harvestEndDay)}`;

  let subject, message, urgency;
  if (m.send === "harvestDay") {
    urgency = "high";
    if (m.daysLate === 0) {
      subject = `🎉 Harvest Day: Your ${crop.name} is Ready!`;
      message = `Today is the day! Your ${name} is ready for harvesting.`;
    } else {
      subject = `🎉 Your ${crop.name} is Ready to Harvest`;
      message = `Your ${name} has been ready for harvesting for ${m.daysLate} day${m.daysLate === 1 ? "" : "s"}. The harvest window runs until ${formatDay(m.harvestEndDay)}.`;
    }
  } else if (m.send === "oneDay") {
    urgency = "medium";
    subject = `⏰ Harvest Tomorrow: ${crop.name}`;
    message = `Your ${name} will be ready for harvest tomorrow (${formatDay(m.harvestStartDay)}).`;
  } else {
    urgency = "low";
    subject = `📅 Harvest ${when === "today" ? "Today" : `in ${m.daysUntilHarvest} Days`}: ${crop.name}`;
    message = `Your ${name} will be ready for harvest ${when} (on ${formatDay(m.harvestStartDay)}).`;
  }

  const border = { high: "#e74c3c", medium: "#f39c12", low: "#27ae60" }[urgency];
  const html = `<!DOCTYPE html><html><head><style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #0e7a5a, #0e3b2e); color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
    .content { background: #f8fbf9; padding: 20px; border-radius: 0 0 10px 10px; }
    .crop-card { background: white; padding: 15px; margin: 15px 0; border-radius: 8px; border-left: 4px solid ${border}; }
    .footer { text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; }
  </style></head><body><div class="container">
    <div class="header"><h1>🌱 Crop Calendar Reminder</h1></div>
    <div class="content">
      <p>Hello ${escapeHtml(user.name || "Farmer")},</p>
      <p>${message}</p>
      <div class="crop-card">
        <h3>Crop Details:</h3>
        <p><strong>Crop Name:</strong> ${name}</p>
        <p><strong>Type:</strong> ${escapeHtml(crop.type)}</p>
        <p><strong>Planted On:</strong> ${formatDay(istDay(crop.plantDate))}</p>
        <p><strong>Growth Duration:</strong> ${escapeHtml(crop.growDuration)} days</p>
        <p><strong>Harvest Window:</strong> ${window} (${Math.max(1, Number(crop.harvestDuration) || 1)} day${(Number(crop.harvestDuration) || 1) === 1 ? "" : "s"})</p>
      </div>
      <p>Best regards,<br>The Crop Calendar Team</p>
    </div>
    <div class="footer"><p>This is an automated notification from your Crop Calendar.</p><p>You can manage your notification preferences in your account settings.</p></div>
  </div></body></html>`;

  return { subject, html };
}

/**
 * Sends today's harvest reminders. Returns { crops, sent, caughtUp, closed, failed }.
 * `deps` lets tests supply the models, the clock and the mailer.
 */
export async function checkCropDeadlines(deps = {}) {
  const now = deps.now ?? new Date();
  const sendMail = deps.sendMail ?? defaultSendMail;
  const UserCrop = deps.UserCrop ?? mongoose.model("UserCrop");

  const summary = { crops: 0, sent: 0, caughtUp: 0, closed: 0, failed: 0 };
  console.log("\n--- Checking crop deadlines (IST) ---");

  const crops = await UserCrop.find().populate("userId", "email name notificationPreferences").lean();
  for (const crop of crops) {
    const user = crop.userId;
    if (!user?.email || !wantsEmail(user, "harvest")) continue;
    summary.crops += 1;

    const m = harvestMilestone({ plantDate: crop.plantDate, growDuration: crop.growDuration, harvestDuration: crop.harvestDuration, sent: crop.notificationsSent ?? {}, now });

    if (m.send) {
      const { subject, html } = harvestEmail(user, crop, m);
      try {
        await sendMail({ from: `"Crop Calendar Notifications" <${process.env.GMAIL_USER}>`, to: user.email, subject, html });
      } catch (err) {
        // Not marked as sent, so the next run tries again.
        console.error(`❌ Failed to send ${m.send} reminder for ${crop.name} to ${user.email}: ${err.message}`);
        summary.failed += 1;
        continue;
      }
      summary.sent += 1;
      if (m.daysLate > 0) summary.caughtUp += 1;
      console.log(`✅ ${m.send} reminder sent to ${user.email} for ${crop.name}`);
    } else if (m.expired) {
      summary.closed += 1;
    }

    if (m.markSent.length > 0) {
      await UserCrop.updateOne({ _id: crop._id }, { $set: Object.fromEntries(m.markSent.map((flag) => [`notificationsSent.${flag}`, true])) });
    }
  }

  console.log(`✅ Deadline check completed: ${summary.sent} sent (${summary.caughtUp} late), ${summary.closed} closed, ${summary.failed} failed.`);
  return summary;
}

// ---------------------------------------------------------------- weather alerts

const ALERT_LABEL = { heavy_rain: "heavy rain", frost: "frost", strong_wind: "strong wind", extreme_heat: "extreme heat" };

function weatherEmail(user, city, alerts) {
  const items = alerts.map((a) => `<p style="padding:10px;border:1px solid #c82333;background:#f8d7da;"><strong>${escapeHtml(ALERT_LABEL[a.type])}:</strong> ${escapeHtml(a.message)}</p>`).join("");
  return {
    subject: `🚨 Weather alert for ${city}: ${alerts.map((a) => ALERT_LABEL[a.type]).join(", ")} - Green Guide`,
    html: `<h3 style="color:#c82333;">Weather alert for ${escapeHtml(city)}</h3>
      <p>Dear ${escapeHtml(user.name || "Farmer")},</p>
      <p>This is an automated alert for your saved location.</p>
      ${items}
      <p>Please check your fields and take suitable precautions.</p>
      <p>You will not get another alert of the same kind today. The Green Guide Team</p>`,
  };
}

async function defaultFetchWeather(city) {
  const current = await fetchCurrentWeather(city);
  const forecast = await fetchForecast(current.coord.lat, current.coord.lon);
  return { current, forecast };
}

/**
 * Checks the weather for every user with a saved location and emails new alerts.
 * One weather lookup per distinct city per run. Returns counts.
 */
export async function runWeatherAlertJob(deps = {}) {
  const now = deps.now ?? new Date();
  const sendMail = deps.sendMail ?? defaultSendMail;
  const fetchWeather = deps.fetchWeather ?? defaultFetchWeather;
  const User = deps.User ?? mongoose.model("User");

  const summary = { users: 0, emailed: 0, alerts: 0, optedOut: 0, onCooldown: 0, failed: 0, cities: 0 };

  if (!deps.fetchWeather && !process.env.OPENWEATHER_API_KEY) {
    console.error("❌ OPENWEATHER_API_KEY is missing in .env. Skipping weather check.");
    return { ...summary, skipped: "no OpenWeather key" };
  }

  const users = await User.find({ location: { $exists: true, $nin: [null, ""] } })
    .select("email name location notificationPreferences weatherAlertsSent")
    .lean();

  const byCity = new Map(); // lower-cased city -> result of one lookup, shared by everyone in that city
  for (const user of users) {
    summary.users += 1;
    const city = String(user.location ?? "").trim();
    if (!city || !user.email) continue;
    if (!wantsEmail(user, "weather")) { summary.optedOut += 1; continue; }

    const key = city.toLowerCase();
    if (!byCity.has(key)) {
      try {
        byCity.set(key, await fetchWeather(city));
      } catch (err) {
        console.error(`❌ Weather lookup for ${city} failed: ${err.message}`);
        byCity.set(key, null);
      }
    }
    const weather = byCity.get(key);
    if (!weather) { summary.failed += 1; continue; }

    const detected = detectWeatherAlerts(weather.current, weather.forecast, now);
    const fresh = newAlertsOnly(detected, user.weatherAlertsSent, now);
    if (detected.length > fresh.length) summary.onCooldown += detected.length - fresh.length;
    if (fresh.length === 0) continue;

    const { subject, html } = weatherEmail(user, weather.current?.name || city, fresh);
    try {
      await sendMail({ from: `"The Green Guide Alert" <${process.env.GMAIL_USER}>`, to: user.email, subject, html });
    } catch (err) {
      console.error(`❌ Failed to send weather alert to ${user.email}: ${err.message}`);
      summary.failed += 1;
      continue; // not recorded, so the next run tries again
    }
    summary.emailed += 1;
    summary.alerts += fresh.length;
    await User.updateOne({ _id: user._id }, { $set: Object.fromEntries(fresh.map((a) => [`weatherAlertsSent.${a.type}`, now])) });
  }

  summary.cities = byCity.size;
  console.log(`✅ Weather check: ${summary.users} users, ${summary.cities} cities, ${summary.emailed} emailed, ${summary.optedOut} opted out, ${summary.onCooldown} already alerted today.`);
  return summary;
}
