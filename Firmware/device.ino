#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include "DHT.h"

// ============================================================
//  CONFIG — UPDATE THESE
// ============================================================
const char* WIFI_SSID     = "rasmalai";
const char* WIFI_PASSWORD = "restmylife";
const char* SERVER_URL    = "https://hsakaletap-ptt-fabric-classifier.hf.space";

// ============================================================
//  PIN & SENSOR SETUP
// ============================================================
#define DHTPIN     15
#define DHTTYPE    DHT22
#define MOTOR_IN1  18
#define MOTOR_IN2  19

DHT dht(DHTPIN, DHTTYPE);
Adafruit_ADS1115 ads;

// ============================================================
//  TIMING
// ============================================================
unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 5000;  // 5 seconds

// ============================================================
//  SETUP
// ============================================================
void setup() {
    Serial.begin(115200);

    // Motor
    pinMode(MOTOR_IN1, OUTPUT);
    pinMode(MOTOR_IN2, OUTPUT);
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);

    // Sensors
    dht.begin();
    if (!ads.begin()) {
        Serial.println("ERROR: ADS1115 not found!");
        while (1);
    }

    // WiFi
    Serial.print("Connecting to WiFi");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    Serial.print("Connected! IP: ");
    Serial.println(WiFi.localIP());
    Serial.println("System ready. Polling server…");
}

// ============================================================
//  HEARTBEAT — tells the server we're alive
// ============================================================
void sendHeartbeat() {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    String url = String(SERVER_URL) + "/device/heartbeat";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    int code = http.POST("{}");

    if (code > 0) {
        Serial.println("Heartbeat sent");
    } else {
        Serial.print("Heartbeat failed: ");
        Serial.println(http.errorToString(code));
    }
    http.end();
}

// ============================================================
//  LONG-POLL — wait for server to assign work
// ============================================================
String pollForWork() {
    if (WiFi.status() != WL_CONNECTED) return "";

    HTTPClient http;
    String url = String(SERVER_URL) + "/device/poll";
    http.begin(url);
    http.setTimeout(30000);  // 30s timeout to cover 25s server long-poll
    int code = http.GET();

    String action = "";
    if (code == 200) {
        String body = http.getString();
        JsonDocument doc;
        deserializeJson(doc, body);
        action = doc["action"].as<String>();
        Serial.print("Poll response: ");
        Serial.println(action);
    } else {
        Serial.print("Poll error: ");
        Serial.println(code);
    }
    http.end();
    return action;
}

// ============================================================
//  RUB + READ — motor spin, settle, read sensors
// ============================================================
void performRubAndRead() {
    Serial.println(">> Motor ON (rubbing)…");
    digitalWrite(MOTOR_IN1, HIGH);
    digitalWrite(MOTOR_IN2, LOW);
    delay(3000);

    // Stop & settle (avoid EMI noise)
    Serial.println(">> Motor OFF (settling)…");
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    delay(1000);

    // Read static charge (10-sample average)
    float totalVolts = 0;
    for (int i = 0; i < 10; i++) {
        int16_t adc0 = ads.readADC_SingleEnded(0);
        totalVolts += ads.computeVolts(adc0);
        delay(20);
    }
    float staticVolts = totalVolts / 10.0;

    // Read DHT22
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature();

    if (isnan(humidity)) humidity = -1;
    if (isnan(temperature)) temperature = -1;

    Serial.println("--- Readings ---");
    Serial.print("Static charge: "); Serial.print(staticVolts, 4); Serial.println(" V");
    Serial.print("Temperature:   "); Serial.print(temperature); Serial.println(" °C");
    Serial.print("Humidity:      "); Serial.print(humidity); Serial.println(" %");

    // Send results to server
    sendReadings(staticVolts, temperature, humidity);
}

// ============================================================
//  SEND READINGS — POST sensor data to server
// ============================================================
void sendReadings(float staticV, float tempC, float humPct) {
    if (WiFi.status() != WL_CONNECTED) return;

    HTTPClient http;
    String url = String(SERVER_URL) + "/device/result";
    http.begin(url);
    http.addHeader("Content-Type", "application/json");

    JsonDocument doc;
    doc["static_charge_v"] = staticV;
    doc["temperature_c"] = tempC;
    doc["humidity_pct"] = humPct;

    String body;
    serializeJson(doc, body);

    int code = http.POST(body);
    if (code == 200) {
        Serial.println("Readings sent to server OK");
    } else {
        Serial.print("Send readings failed: ");
        Serial.println(code);
    }
    http.end();
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
    // Reconnect WiFi if dropped
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi lost, reconnecting…");
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        while (WiFi.status() != WL_CONNECTED) {
            delay(500);
            Serial.print(".");
        }
        Serial.println("\nReconnected!");
    }

    // Send heartbeat periodically
    if (millis() - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        sendHeartbeat();
        lastHeartbeat = millis();
    }

    // Long-poll for work
    String action = pollForWork();
    if (action == "rub") {
        performRubAndRead();
    }

    // Small delay before next poll cycle (only if no work)
    if (action != "rub") {
        delay(500);
    }
}