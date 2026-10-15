// Host test for the WEBMSG block: compiles the exact block with small stand-ins for the Arduino/ESP32 pieces.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cctype>
#include <ctime>
#include <string>
#include <cstdio>
#undef NDEBUG
#define assert(...) do { if (!(__VA_ARGS__)) { std::printf("ASSERT FAILED line %d: %s\n", __LINE__, #__VA_ARGS__); std::exit(1); } } while (0)
#include <vector>
typedef int portMUX_TYPE; typedef void* TaskHandle_t;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) (void)0
#define portEXIT_CRITICAL(x) (void)0
static TaskHandle_t curTask = (TaskHandle_t)1; TaskHandle_t xTaskGetCurrentTaskHandle() { return curTask; }
static unsigned long fakeMs = 100000; unsigned long millis() { return fakeMs; }
struct String { std::string s; String(const char* c = "") : s(c) {} String(const std::string& c) : s(c) {} const char* c_str() const { return s.c_str(); } size_t length() const { return s.size(); } };
struct SerialT { template <typename... A> void printf(const char* f, A... a) { std::printf(f, a...); } } Serial;
#define WEB_BOT_NAME "YM ORACLE III"
#define ORACLE_WEB_URL "https://example.test"
static std::vector<std::string> posted; static int nextCode = 200;
static uint32_t lastMinHeap = 0; int webLogPostEx(const char* body, uint32_t minHeap) { lastMinHeap = minHeap; posted.push_back(body); return nextCode; }
int webLogDecide(int c) { if (c >= 200 && c < 300) return 0; if (c >= 400 && c < 500 && c != 408 && c != 429) return 2; return 1; }
unsigned long webLogBackoffMs(uint8_t t) { uint8_t x = t == 0 ? 0 : t - 1; if (x > 5) x = 5; unsigned long ms = 10000UL << x; return ms > 300000UL ? 300000UL : ms; }
#include "webmsg_block.cpp"
// minimal JSON string-value reader for the checks (handles \" \\ \n)
static std::string jget(const std::string& j, const char* key) { std::string k = std::string("\"") + key + "\":\""; size_t p = j.find(k); if (p == std::string::npos) return "<none>"; p += k.size(); std::string o; while (p < j.size() && j[p] != '"') { if (j[p] == '\\') { p++; o += (j[p] == 'n' ? '\n' : j[p]); } else o += j[p]; p++; } return o; }
static bool validUtf8(const std::string& s) { size_t i = 0; while (i < s.size()) { unsigned char c = s[i]; int n = c < 0x80 ? 0 : (c >> 5) == 6 ? 1 : (c >> 4) == 14 ? 2 : (c >> 3) == 30 ? 3 : -1; if (n < 0) return false; for (int k = 1; k <= n; k++) if (i + k >= s.size() || ((unsigned char)s[i + k] & 0xC0) != 0x80) return false; i += n + 1; } return true; }
int main() {
  // 1. a normal alert: formatting kept, quotes/newlines escaped, header correct
  String t("\xE2\x9C\x85 <b>YM ORACLE III</b> \"WIN\"\n<pre>Entry $1\\2</pre>");
  assert(webLogMsg(t, true)); assert(webMsgFlush()); assert(posted.size() == 1);
  std::string b = posted[0];
  assert(b.front() == '{' && b.back() == '}' && b.size() < WEBMSG_LEN);
  assert(jget(b, "bot") == "YM ORACLE III" && jget(b, "ev") == "msg" && jget(b, "kind") == "other");
  assert(jget(b, "text") == std::string(t.c_str())); assert(b.find("\"priv\":1") != std::string::npos);
  assert(jget(b, "k").rfind("m-III-", 0) == 0);
  // 2. the hint tags the next message only, and only from the same task
  webLogHint("entry", "BTCUSDT"); assert(webLogMsg(String("e"), false)); webMsgFlush(); assert(jget(posted.back(), "kind") == "entry" && jget(posted.back(), "sym") == "BTCUSDT");
  assert(webLogMsg(String("f"), false)); webMsgFlush(); assert(jget(posted.back(), "kind") == "other", "hint is used once");
  webLogHint("result", "ETH"); curTask = (TaskHandle_t)2; assert(webLogMsg(String("other task"), false)); webMsgFlush(); assert(jget(posted.back(), "kind") == "other", "another task cannot take the hint"); curTask = (TaskHandle_t)1;
  // 3. too long: cut cleanly, never inside a multi-byte character, still valid JSON ending
  std::string longs; for (int i = 0; i < 400; i++) longs += "\xF0\x9F\x9A\xA8 alert \"x\"\n"; posted.clear();
  assert(webLogMsg(String(longs), false)); webMsgFlush(); b = posted[0];
  assert(b.size() < WEBMSG_LEN && b.back() == '}' && b[b.size() - 2] == '"' && validUtf8(jget(b, "text")) && jget(b, "text").size() > 500 && jget(b, "text").substr(jget(b, "text").size() - 3) == "...");
  // 4. failure is retried with backoff; a refusal is dropped; success frees the memory
  posted.clear(); nextCode = 503; assert(webLogMsg(String("retry me"), false)); assert(webMsgFlush() && posted.size() == 1);
  assert(!webMsgFlush(), "not due yet"); fakeMs += 10001; nextCode = 200; assert(webMsgFlush() && posted.size() == 2 && jget(posted[0], "k") == jget(posted[1], "k"), "same key on retry (the relay ignores repeats)");
  assert(!webMsgFlush(), "nothing left");
  nextCode = 401; posted.clear(); assert(webLogMsg(String("refused"), false)); assert(webMsgFlush()); assert(!webMsgFlush(), "a refused alert is dropped, not retried forever"); nextCode = 200;
  // 5. full queue: oldest makes way, the one being sent is never touched; expired are dropped
  posted.clear(); nextCode = 500; for (int i = 0; i < 5; i++) assert(webLogMsg(String(("m" + std::to_string(i)).c_str()), false)); assert(webMsgDrop >= 2);
  fakeMs += 31UL * 60UL * 1000UL; nextCode = 200; webMsgFlush(); assert(!webMsgFlush(), "alerts older than 30 minutes are given up on");
  // 6. keys are unique
  posted.clear(); for (int i = 0; i < 3; i++) { webLogMsg(String("x"), false); webMsgFlush(); } assert(jget(posted[0], "k") != jget(posted[1], "k") && jget(posted[1], "k") != jget(posted[2], "k"));
  assert(lastMinHeap == 22000UL, "alerts use their own memory floor");
  std::puts("WEBMSG HOST TEST OK"); return 0;
}
