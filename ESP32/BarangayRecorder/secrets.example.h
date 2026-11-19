#pragma once

// Copy to secrets.h in this folder. Keep secrets.h out of Git and chat.
const char* WIFI_SSID = "YOUR_2_4_GHZ_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Optional backup Wi-Fi. Leave both blank to disable it.
#define FALLBACK_WIFI_SSID ""
#define FALLBACK_WIFI_PASSWORD ""

const char* API_BASE_URL = "https://pob3-a.vercel.app";
const char* DEVICE_TOKEN = "bwcam_1_0ed6bc23f43d0d159d873d03e540f9bac59bcb8bb0036c8c702f8fd1fc954258";

// Required only while Vercel Deployment Protection is enabled.
// Create this in Vercel Project Settings > Deployment Protection > Protection Bypass for Automation.
// Keep the generated value private; the firmware sends it as an HTTPS header.
#define VERCEL_PROTECTION_BYPASS ""