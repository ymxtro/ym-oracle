// ===== WEBMSG-BEGIN =====
// ALERTS VIA RENDER. Every alert this bot used to push to Telegram itself is handed to the Render relay instead, as one small report
// ("ev":"msg"). The relay stores it, sends it to Telegram (and email for the daily summary) and retries until it is delivered; a repeat
// of the same report (same "k") is ignored there, so retrying can never send an alert twice. Nothing here can touch trading.
// Memory: no standing buffer. A report's text is allocated when it is queued and freed the moment Render accepts it.
// If a report cannot be queued (no memory) webLogMsg() returns false and the caller uses the old direct path, so an alert is never lost to this.
#define WEBMSG_SLOTS 3
#define WEBMSG_LEN 1100
#define WEBMSG_MAX_AGE_MS (30UL * 60UL * 1000UL)
#define WEBMSG_MIN_HEAP 22000UL   // alerts may go out with less free memory than the ledger reports (30000): the old Telegram path had no such guard, so this must not be stricter than needed
struct WebMsgItem { bool used; bool inflight; uint8_t tries; unsigned long seq; unsigned long queuedMs; unsigned long nextMs; char* body; };
WebMsgItem webMsgQ[WEBMSG_SLOTS];
portMUX_TYPE webMsgMux = portMUX_INITIALIZER_UNLOCKED;
unsigned long webMsgSeq = 0;
uint32_t webMsgOk = 0, webMsgFail = 0, webMsgDrop = 0;
char webHintKind[12] = "";
char webHintSym[24] = "";
TaskHandle_t webHintTask = nullptr;

// Called just before a message that has a special meaning for the relay ("entry", "result", "daily"). Only the same task's next webLogMsg() uses it.
void webLogHint(const char* kind, const char* symbol) {
  portENTER_CRITICAL(&webMsgMux);
  strncpy(webHintKind, kind ? kind : "", sizeof(webHintKind) - 1); webHintKind[sizeof(webHintKind) - 1] = '\0';
  strncpy(webHintSym, symbol ? symbol : "", sizeof(webHintSym) - 1); webHintSym[sizeof(webHintSym) - 1] = '\0';
  webHintTask = xTaskGetCurrentTaskHandle();
  portEXIT_CRITICAL(&webMsgMux);
}

// Queues one alert for Render. Returns true when it is queued (the caller must then NOT also send it the old way).
bool webLogMsg(const String& text, bool priv) {
  char kind[12] = "other", sym[24] = "";
  portENTER_CRITICAL(&webMsgMux);
  if (webHintTask != nullptr && webHintTask == xTaskGetCurrentTaskHandle()) {
    if (webHintKind[0]) { strncpy(kind, webHintKind, sizeof(kind) - 1); kind[sizeof(kind) - 1] = '\0'; }
    strncpy(sym, webHintSym, sizeof(sym) - 1); sym[sizeof(sym) - 1] = '\0';
    webHintTask = nullptr; webHintKind[0] = '\0'; webHintSym[0] = '\0';
  }
  unsigned long seq = ++webMsgSeq;
  portEXIT_CRITICAL(&webMsgMux);
  for (char* c = kind; *c; c++) if (!isalnum((unsigned char)*c)) *c = '_';
  for (char* c = sym; *c; c++) if (!isalnum((unsigned char)*c)) *c = '_';

  char* buf = (char*)malloc(WEBMSG_LEN);
  if (buf == nullptr) return false;
  const char* nm = WEB_BOT_NAME;
  const char* sp = strrchr(nm, ' ');
  const char* shortId = sp ? sp + 1 : nm;
  time_t nowE = time(nullptr);
  unsigned long stamp = nowE > 1000000000 ? (unsigned long)nowE : millis() / 1000UL;
  int n = snprintf(buf, WEBMSG_LEN, "{\"v\":1,\"bot\":\"%s\",\"ev\":\"msg\",\"k\":\"m-%s-%lu-%lu\",\"kind\":\"%s\",\"sym\":\"%s\",\"priv\":%d,\"text\":\"",
                   nm, shortId, stamp, seq, kind, sym, priv ? 1 : 0);
  if (n < 0 || n >= WEBMSG_LEN - 16) { free(buf); return false; }
  size_t j = (size_t)n, head = j;
  const char* t = text.c_str();
  size_t len = text.length(), i = 0;
  for (; i < len && j + 8 < (size_t)WEBMSG_LEN - 4; i++) {          // keeps room for an escape pair, the "..." and the closing "}
    unsigned char c = (unsigned char)t[i];
    if (c == '"' || c == '\\') { buf[j++] = '\\'; buf[j++] = (char)c; }
    else if (c == '\n') { buf[j++] = '\\'; buf[j++] = 'n'; }
    else if (c < 0x20) buf[j++] = ' ';
    else buf[j++] = (char)c;
  }
  if (i < len) {                                                    // too long: cut cleanly (never in the middle of a multi-byte character) and say so
    while (j > head && ((unsigned char)buf[j - 1] & 0xC0) == 0x80) j--;
    if (j > head && ((unsigned char)buf[j - 1] & 0xC0) == 0xC0) j--;
    buf[j++] = '.'; buf[j++] = '.'; buf[j++] = '.';
  }
  buf[j++] = '"'; buf[j++] = '}'; buf[j] = '\0';

  char* dropped = nullptr;
  bool placed = false;
  portENTER_CRITICAL(&webMsgMux);
  int slot = -1;
  for (int s = 0; s < WEBMSG_SLOTS; s++) if (!webMsgQ[s].used) { slot = s; break; }
  if (slot < 0) {                                                   // full: the oldest report that is not being sent right now makes way
    for (int s = 0; s < WEBMSG_SLOTS; s++) if (!webMsgQ[s].inflight && (slot < 0 || webMsgQ[s].seq < webMsgQ[slot].seq)) slot = s;
    if (slot >= 0) { dropped = webMsgQ[slot].body; webMsgDrop++; }
  }
  if (slot >= 0) {
    WebMsgItem& w = webMsgQ[slot];
    w.used = true; w.inflight = false; w.tries = 0; w.seq = seq; w.queuedMs = millis(); w.nextMs = w.queuedMs; w.body = buf;
    placed = true;
  }
  portEXIT_CRITICAL(&webMsgMux);
  if (dropped) free(dropped);
  if (!placed) { free(buf); return false; }
  return true;
}

// Sends at most ONE queued alert per call (oldest first). Returns true when it made a network attempt, so the caller can leave the ledger reports for the next pass.
bool webMsgFlush() {
  unsigned long now = millis();
  int slot = -1;
  char* expired = nullptr;
  portENTER_CRITICAL(&webMsgMux);
  for (int s = 0; s < WEBMSG_SLOTS; s++) {
    WebMsgItem& w = webMsgQ[s];
    if (!w.used || w.inflight) continue;
    if (now - w.queuedMs > WEBMSG_MAX_AGE_MS) { expired = w.body; w.body = nullptr; w.used = false; webMsgDrop++; continue; }
    if ((long)(now - w.nextMs) < 0) continue;
    if (slot < 0 || w.seq < webMsgQ[slot].seq) slot = s;
  }
  if (slot >= 0) webMsgQ[slot].inflight = true;
  portEXIT_CRITICAL(&webMsgMux);
  if (expired) free(expired);
  if (slot < 0) return false;

  int code = webLogPostEx(webMsgQ[slot].body, WEBMSG_MIN_HEAP);     // the same HTTPS path and network lock as the ledger reports, with a lower memory floor
  if (code == -9999) { portENTER_CRITICAL(&webMsgMux); webMsgQ[slot].inflight = false; portEXIT_CRITICAL(&webMsgMux); return false; }
  int decision = webLogDecide(code);
  char* done = nullptr;
  portENTER_CRITICAL(&webMsgMux);
  WebMsgItem& w = webMsgQ[slot];
  if (decision == 1) { if (w.tries < 250) w.tries++; w.nextMs = now + webLogBackoffMs(w.tries); w.inflight = false; webMsgFail++; }
  else { done = w.body; w.body = nullptr; w.used = false; w.inflight = false; if (decision == 0) webMsgOk++; else webMsgDrop++; }
  portEXIT_CRITICAL(&webMsgMux);
  if (done) free(done);
  if (decision != 0) Serial.printf("[WEB] alert to %s %s (HTTP %d)\n", ORACLE_WEB_URL, decision == 1 ? "failed, will retry" : "refused, dropped", code);
  return true;
}
// ===== WEBMSG-END =====
