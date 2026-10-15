import sys,re
src,dst=sys.argv[1],sys.argv[2]
s=open(src,encoding='utf-8').read()
block=open('/home/claude/fw/webmsg_block.cpp',encoding='utf-8').read()+'\n'+open('/home/claude/fw/webtest_block.cpp',encoding='utf-8').read()
def once(old,new,label):
    global s
    assert s.count(old)==1,(label,s.count(old))
    s=s.replace(old,new,1)

# A. the switch (next to the existing Render settings)
m=re.search(r'^#define ORACLE_WEB_DEVICE_KEY .*$',s,re.M); assert m
s=s[:m.end()]+'''
// ALERTS VIA RENDER: 1 = this bot no longer sends its own Telegram or email alerts; each alert goes to the Render relay, which delivers it
// (stored, retried, never sent twice). 0 = exactly the old behaviour, so flipping this back and reflashing undoes the whole change.
#define ALERTS_VIA_RENDER 1'''+s[m.end():]

# B. prototypes
m=re.search(r'^bool sendTelegramMessage\(const String& text, const char\* targetChatId = TELEGRAM_CHAT_ID\);.*$',s,re.M); assert m
s=s[:m.end()]+'''
#if ALERTS_VIA_RENDER
bool webLogMsg(const String& text, bool priv);
void webLogHint(const char* kind, const char* symbol);
void webLogQueue(const char* json, bool isStatus);
bool webLogInit();
bool webMsgFlush();
int webLogPostEx(const char* body, uint32_t minHeap);
String webLogTestNow();
const char* webLogTestWords(int code, const char* reply);
#endif'''+s[m.end():]

# C. chokepoints
once('''bool sendTelegramMessage(const String& text, const char* targetChatId) {
  if (!telegramAlertsEnabled) return true; // unchanged: intentionally skipped, not a failure
  queueTelegramAlert_(text, targetChatId);
  return true;
}''','''bool sendTelegramMessage(const String& text, const char* targetChatId) {
  if (!telegramAlertsEnabled) return true; // unchanged: intentionally skipped, not a failure
#if ALERTS_VIA_RENDER
  // Handed to Render (which delivers it to Telegram). Only if it cannot be queued here (no memory) does the old direct path run, so an alert is never lost.
  if (webLogMsg(text, strcmp(targetChatId, TELEGRAM_PRIVATE_CHAT_ID) == 0)) return true;
#endif
  queueTelegramAlert_(text, targetChatId);
  return true;
}''','chokepoint telegram')
once('''bool sendEmailWithRetry() {
  if (!emailAlertsEnabled) return true; // unchanged: intentionally skipped, not a failure''','''bool sendEmailWithRetry() {
  if (!emailAlertsEnabled) return true; // unchanged: intentionally skipped, not a failure
#if ALERTS_VIA_RENDER
  return true; // every alert that also had an email already went to Render through sendTelegramMessage(); Render emails the ones you want emailed
#endif''','chokepoint email')

# D. kind hints at the entry and result alerts, and the daily summary (email-only before: its text now goes to Render)
once('''  bool tgOk = sendTelegramMessage(tgText);
  if (tgOk) {
    Serial.printf("[📨 ENTRY TELEGRAM SENT] %s\\n", pos.symbol);''','''#if ALERTS_VIA_RENDER
  webLogHint("entry", pos.symbol);
#endif
  bool tgOk = sendTelegramMessage(tgText);
  if (tgOk) {
    Serial.printf("[📨 ENTRY TELEGRAM SENT] %s\\n", pos.symbol);''','entry hint')
once('''  bool tgOkResult = sendTelegramMessage(tgText);''','''#if ALERTS_VIA_RENDER
  webLogHint("result", pos.symbol);
#endif
  bool tgOkResult = sendTelegramMessage(tgText);''','result hint')
once('''  if (sendEmailWithRetry()) {
    Serial.println("[✉️ DAILY SUMMARY EMAIL SENT]");
  }''','''#if ALERTS_VIA_RENDER
  // The daily summary was email-only. Its text is now sent to Render, which emails it (and shows it in the console). If it cannot be queued
  // here, the email that was already built above goes out the old way.
  if (emailAlertsEnabled) {
    webLogHint("daily", "");
    if (webLogMsg(tgText, false)) Serial.println("[DAILY SUMMARY QUEUED FOR RENDER]");
    else if (queueEmailAlert_(String(message.subject.c_str()), String(message.html.content.c_str()))) Serial.println("[✉️ DAILY SUMMARY EMAIL QUEUED]");
  }
#else
  if (sendEmailWithRetry()) {
    Serial.println("[✉️ DAILY SUMMARY EMAIL SENT]");
  }
#endif''','daily')

# E. flush: alerts first, ledger reports on the next pass
once('''    webLogStatusNow(cfg);
  }
  webLogFlush();
}''','''    webLogStatusNow(cfg);
  }
#if ALERTS_VIA_RENDER
  if (webMsgFlush()) return;   // one report per pass: an alert goes first, the ledger reports follow on the next pass
#endif
  webLogFlush();
}''','tick')

# F. no SMTP login at boot (the near-miss archive connects when it needs to)
once('''  if (!smtp.connect(&smtpConfig)) {
    Serial.println("[-] Initial SMTP Connect Failed");
  } else {
    Serial.println("[+] SMTP Connected Successfully");
  }''','''#if ALERTS_VIA_RENDER
  Serial.println("[i] SMTP not opened at boot: alerts go through Render. It connects only when the near-miss archive email needs it.");
#else
  if (!smtp.connect(&smtpConfig)) {
    Serial.println("[-] Initial SMTP Connect Failed");
  } else {
    Serial.println("[+] SMTP Connected Successfully");
  }
#endif''','smtp boot')

# G. the Test alert button now tests the real route
once('''void handleTestAlertWeb() {
  message.clear();''','''void handleTestAlertWeb() {
#if ALERTS_VIA_RENDER
  // Tests the real route AND says what happened: this bot -> Render -> Telegram. The reply states Render's actual answer in plain words.
  webServer.send(200, "text/plain; charset=utf-8", webLogTestNow());
  return;
#endif
  message.clear();''','test handler')

# G2. one shared HTTPS sender with a per-call memory floor (the ledger keeps 30000; alerts use 22000)
once('''int webLogPost(const char* body) {
  if (WiFi.status() != WL_CONNECTED) return -9999;
  if (ESP.getFreeHeap() < WEBLOG_MIN_HEAP) return -9999;''','''int webLogPostEx(const char* body, uint32_t minHeap);
int webLogPost(const char* body) { return webLogPostEx(body, WEBLOG_MIN_HEAP); }
int webLogPostEx(const char* body, uint32_t minHeap) {
  if (WiFi.status() != WL_CONNECTED) return -9999;
  if (ESP.getFreeHeap() < minHeap) return -9999;''','post ex')

# I. Render posts may never outlast the scan's own 8 s wait for the network lock: connect 2.5 s + read 3.5 s = 6 s at most (was 3 + 5 = 8).
# Safe: a post that times out is retried with backoff, and the relay ignores a repeat of the same key, so nothing is lost or doubled.
once('  scanHttp.setConnectTimeout(3000);\n  scanHttp.setTimeout(5000);\n  scanHttp.addHeader("Content-Type", "application/json");',
     '  scanHttp.setConnectTimeout(2500);   // with the read timeout below: at most 6 s holding the shared network lock, always under the scan\'s 8 s wait\n  scanHttp.setTimeout(3500);\n  scanHttp.addHeader("Content-Type", "application/json");', 'post timeouts')

# J. log-only health lines (no behaviour change): memory and stack headroom once per scan, largest free block on a failed fetch
once('    if (scanSec > 600UL) funnel.scanOver600s++;',
     '    if (scanSec > 600UL) funnel.scanOver600s++;\n    Serial.printf("[i] Health: free heap %u, lowest ever %u, largest free block %u, scan-task stack headroom %u bytes.\\n", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(), (unsigned)ESP.getMaxAllocHeap(), (unsigned)uxTaskGetStackHighWaterMark(NULL));', 'health line')
once('transport error %d (%s) | free heap: %u bytes\\n", symbol, httpCode, client.errorToString(httpCode).c_str(), ESP.getFreeHeap());',
     'transport error %d (%s) | free heap: %u bytes, largest block %u\\n", symbol, httpCode, client.errorToString(httpCode).c_str(), ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());', 'fail line')


# K. alert categories: tell Render what each alert IS so the admin console can route it (group / DM / off) without a reflash.
# Each hint is consumed by the very next webLogMsg() on the same task; an alert without a hint is still routed (guessed from where it was addressed).
def hint(old, new_kind_expr, label, extra=''):
    once(old, '#if ALERTS_VIA_RENDER\n  ' + new_kind_expr + '\n#endif\n' + old, label)
hint('  bool tgOk = sendTelegramMessage(tgText, TELEGRAM_PRIVATE_CHAT_ID);\n  if (tgOk) Serial.printf("[📨 FUTURE ZONE TELEGRAM SENT', 'webLogHint("zone", f.symbol);', 'hint zone')
hint('  bool tgOk = sendTelegramMessage(tgText);\n  if (tgOk) Serial.printf("[📨 FUTURE ENTRY FIRED TELEGRAM SENT', 'webLogHint("entry", f.symbol);', 'hint fired')
hint('  bool tgOk = sendTelegramMessage(tgText, TELEGRAM_PRIVATE_CHAT_ID);\n  bool emailOk = sendEmailWithRetry();', 'webLogHint("zone", f.symbol);', 'hint cancelled')
hint('  bool tgOkMgmt = sendTelegramMessage(tgText, targetChatId);', 'webLogHint("mgmt", pos.symbol);', 'hint mgmt')
hint('  bool tgOkSl = sendTelegramMessage(tgText);', 'webLogHint("mgmt", pos.symbol);', 'hint sl')
hint('  bool tgOkExt = sendTelegramMessage(tgText);', 'webLogHint("mgmt", pos.symbol);', 'hint tp ext')
hint('        sendTelegramMessage(tg);\n', 'webLogHint("ops", "");', 'hint breaker')
hint('        sendTelegramMessage("\\xE2\\x9C\\x85 Circuit breaker reset', 'webLogHint("ops", "");', 'hint breaker reset')
hint('    sendTelegramMessage(String(buf), TELEGRAM_PRIVATE_CHAT_ID); // your private chat', 'webLogHint("ops", "");', 'hint relay failure')


# H. the block itself, right after webLogPost
once('int webLogOpenCount() {','#if ALERTS_VIA_RENDER\n'+block+'#endif\n\nint webLogOpenCount() {','block')
open(dst,'w',encoding='utf-8').write(s)
# sanity: balanced preprocessor conditionals
n_if=len(re.findall(r'^\s*#\s*if',s,re.M)); n_end=len(re.findall(r'^\s*#\s*endif',s,re.M)); assert n_if==n_end,(n_if,n_end)
print(dst,'ok',n_if)
