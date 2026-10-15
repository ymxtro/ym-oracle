// ===== WEBTEST-BEGIN =====
// The "Send test alert" button: sends the test to Render RIGHT NOW and reports what Render actually answered, in plain words, instead of
// queueing it and leaving you to guess. Pure part first (host-tested): turns the HTTP code and Render's reply into a sentence.
const char* webLogTestWords(int code, const char* reply) {
  if (code == -9999) return "The bot could not try: Wi-Fi is down, memory is low, or it is busy fetching candles. Press again in a few seconds.";
  if (code < 0) return "The bot could not reach Render (no answer). Check this bot's Wi-Fi and that its Render address is right. If Render was asleep, press again in a minute.";
  if (code == 200) {
    if (reply != nullptr && strstr(reply, "delivered") != nullptr) return "OK: Render got the test and sent it to Telegram. Look in Telegram now.";
    if (reply != nullptr && strstr(reply, "not configured") != nullptr) return "Render got the test, but alerts are not set up there. Add ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID on Render.";
    if (reply != nullptr && strstr(reply, "delivery failed") != nullptr) return "Render got the test, but Telegram refused it. Check the bot token and chat id on Render.";
    return "Render answered OK but did not say it delivered the test. Check Telegram and the console Recent alerts.";
  }
  if (code == 400) return "Render refused the test (HTTP 400): the relay on Render is an older version that does not know this message. Deploy relay v2.4 first.";
  if (code == 401 || code == 403) return "Render refused this bot (HTTP 401): the device key does not match. Put Render's DEVICE_API_KEY into this bot's ORACLE_WEB_DEVICE_KEY, or set DEVICE_KEY_MODE=warn.";
  if (code == 404) return "Render does not have this feature (HTTP 404): the relay on Render is too old. Deploy relay v2.4.";
  if (code == 429) return "Render said too soon (HTTP 429). Wait 15 seconds and press again.";
  if (code >= 500) return "Render had an error or is waking up (HTTP 5xx). Press again in a minute.";
  return "Render answered with an unexpected code. Check the Render logs.";
}
// ===== WEBTEST-END =====

// The networked part (real hardware only): one POST, the shared network lock, the same 6 s ceiling as every other Render post.
String webLogTestNow() {
  char tbuf[96];
  snprintf(tbuf, sizeof(tbuf), "{\"v\":1,\"bot\":\"%s\",\"ev\":\"test\",\"t\":%lu}", WEB_BOT_NAME, (unsigned long)time(nullptr));
  if (WiFi.status() != WL_CONNECTED) return String(webLogTestWords(-9999, nullptr));
  if (ESP.getFreeHeap() < WEBMSG_MIN_HEAP) return String(webLogTestWords(-9999, nullptr));
  NetworkFetchLock testLock(3000);
  if (!testLock.isAcquired()) return String(webLogTestWords(-9999, nullptr));
  WiFiClientSecure testClient;
  testClient.setInsecure();
  scanHttp.begin(testClient, String(ORACLE_WEB_URL) + "/api/bot-event");
  scanHttp.setConnectTimeout(2500);
  scanHttp.setTimeout(3500);
  scanHttp.addHeader("Content-Type", "application/json");
  if (strlen(ORACLE_WEB_DEVICE_KEY) > 0) scanHttp.addHeader("X-Device-Key", ORACLE_WEB_DEVICE_KEY);
  int code = scanHttp.POST((uint8_t*)tbuf, strlen(tbuf));
  String reply = (code > 0) ? scanHttp.getString() : String("");
  scanHttp.end();
  return String(webLogTestWords(code, reply.c_str())) + " [HTTP " + String(code) + "]";
}
