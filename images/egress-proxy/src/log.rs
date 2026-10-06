//! Structured logging: one JSON object per line.
//!
//! JSON encoding and RFC 3339 timestamps are implemented here (and unit
//! tested against `serde_json`) so the binary needs no dependency beyond
//! tokio.

use std::fmt::Write as _;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Longest attacker-influenced string written into a single log field.
pub const MAX_FIELD_LEN: usize = 256;

/// Builder for one log line. `ts` and `action` always come first.
#[derive(Debug)]
pub struct Record {
    buf: String,
}

impl Record {
    pub fn new(action: &str) -> Self {
        Self::at(SystemTime::now(), action)
    }

    pub fn at(ts: SystemTime, action: &str) -> Self {
        let mut buf = String::with_capacity(192);
        buf.push_str("{\"ts\":\"");
        buf.push_str(&rfc3339(ts));
        buf.push_str("\",\"action\":");
        push_json_string(&mut buf, action);
        Self { buf }
    }

    fn key(&mut self, key: &str) {
        self.buf.push(',');
        push_json_string(&mut self.buf, key);
        self.buf.push(':');
    }

    /// String field. Over-long values are truncated to [`MAX_FIELD_LEN`]
    /// characters so a hostile client cannot bloat the log.
    pub fn str(mut self, key: &str, value: &str) -> Self {
        self.key(key);
        match value.char_indices().nth(MAX_FIELD_LEN) {
            Some((cut, _)) => push_json_string(&mut self.buf, &value[..cut]),
            None => push_json_string(&mut self.buf, value),
        }
        self
    }

    pub fn num(mut self, key: &str, value: u64) -> Self {
        self.key(key);
        let _ = write!(self.buf, "{value}");
        self
    }

    pub fn boolean(mut self, key: &str, value: bool) -> Self {
        self.key(key);
        self.buf.push_str(if value { "true" } else { "false" });
        self
    }

    pub fn str_array(mut self, key: &str, values: &[String]) -> Self {
        self.key(key);
        self.buf.push('[');
        for (i, v) in values.iter().enumerate() {
            if i > 0 {
                self.buf.push(',');
            }
            push_json_string(&mut self.buf, v);
        }
        self.buf.push(']');
        self
    }

    pub fn finish(mut self) -> String {
        self.buf.push('}');
        self.buf
    }
}

fn push_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // Other C0 controls, DEL, and the Unicode line separators (which
            // some log shippers treat as newlines).
            c if (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{2028}' || c == '\u{2029}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// RFC 3339 UTC timestamp with millisecond precision.
pub fn rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian
/// calendar (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Destination for log lines.
pub trait LogSink: Send + Sync + 'static {
    fn emit(&self, line: String);
}

/// Writes each line to stdout (line-buffered by the standard library, so one
/// `write(2)` per record).
#[derive(Debug, Default)]
pub struct StdoutSink;

impl LogSink for StdoutSink {
    fn emit(&self, line: String) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
}

/// Collects lines in memory; used by tests.
#[derive(Debug, Default)]
pub struct MemorySink {
    lines: Mutex<Vec<String>>,
}

impl MemorySink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn lines(&self) -> Vec<String> {
        match self.lines.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }
}

impl LogSink for MemorySink {
    fn emit(&self, line: String) {
        match self.lines.lock() {
            Ok(mut g) => g.push(line),
            Err(p) => p.into_inner().push(line),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64, millis: u32) -> SystemTime {
        UNIX_EPOCH + Duration::new(secs, millis * 1_000_000)
    }

    #[test]
    fn rfc3339_known_instants() {
        assert_eq!(rfc3339(at(0, 0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(at(86_399, 999)), "1970-01-01T23:59:59.999Z");
        assert_eq!(rfc3339(at(86_400, 0)), "1970-01-02T00:00:00.000Z");
        assert_eq!(rfc3339(at(951_782_400, 0)), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(at(951_868_800, 0)), "2000-03-01T00:00:00.000Z");
        assert_eq!(rfc3339(at(1_709_164_800, 0)), "2024-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(at(1_735_689_599, 0)), "2024-12-31T23:59:59.000Z");
        assert_eq!(rfc3339(at(1_735_689_600, 7)), "2025-01-01T00:00:00.007Z");
        assert_eq!(rfc3339(at(1_791_288_000, 123)), "2026-10-06T12:00:00.123Z");
        assert_eq!(rfc3339(at(4_102_444_800, 0)), "2100-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(at(4_107_542_400, 0)), "2100-03-01T00:00:00.000Z");
    }

    #[test]
    fn record_is_valid_json_with_expected_fields() {
        let line = Record::at(at(1_791_288_000, 5), "deny")
            .str("host", "example.com")
            .num("port", 443)
            .str("reason", "not_allowlisted")
            .str("client", "172.20.0.3:51234")
            .num("bytes_up", u64::MAX)
            .boolean("flag", true)
            .str_array(
                "allow",
                &["a.example:443".into(), "*.b.example:8443".into()],
            )
            .finish();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ts"], "2026-10-06T12:00:00.005Z");
        assert_eq!(v["action"], "deny");
        assert_eq!(v["host"], "example.com");
        assert_eq!(v["port"], 443);
        assert_eq!(v["reason"], "not_allowlisted");
        assert_eq!(v["client"], "172.20.0.3:51234");
        assert_eq!(v["bytes_up"], u64::MAX);
        assert_eq!(v["flag"], true);
        assert_eq!(v["allow"][1], "*.b.example:8443");
        assert!(!line.contains('\n'));
    }

    #[test]
    fn hostile_strings_are_escaped_and_stay_on_one_line() {
        let nasty =
            "a\"b\\c\nd\re\tf\u{0}g\u{1b}[31mh\u{7f}i\u{2028}j\u{2029}k é 日本 \u{1f600} </script>";
        let line = Record::new("deny")
            .str("host", nasty)
            .str("we\"ird\nkey", "v")
            .finish();
        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
        assert!(!line.contains('\u{1b}'));
        assert!(!line.contains('\u{2028}'));
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["host"], nasty);
        assert_eq!(v["we\"ird\nkey"], "v");
    }

    #[test]
    fn every_control_character_round_trips() {
        for cp in 0u32..0x100 {
            let c = char::from_u32(cp).unwrap();
            let s = format!("x{c}y");
            let line = Record::new("t").str("k", &s).finish();
            let v: serde_json::Value =
                serde_json::from_str(&line).unwrap_or_else(|e| panic!("U+{cp:04X}: {e}: {line}"));
            assert_eq!(v["k"], s, "U+{cp:04X}");
            assert!(line.bytes().all(|b| b >= 0x20), "U+{cp:04X} leaked raw");
        }
    }

    #[test]
    fn long_values_are_truncated_on_a_char_boundary() {
        let long = "é".repeat(MAX_FIELD_LEN + 50);
        let line = Record::new("t").str("k", &long).finish();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["k"].as_str().unwrap().chars().count(), MAX_FIELD_LEN);
        let exact = "a".repeat(MAX_FIELD_LEN);
        let line = Record::new("t").str("k", &exact).finish();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["k"], exact);
    }

    #[test]
    fn empty_array_and_memory_sink() {
        let line = Record::new("start").str_array("allow", &[]).finish();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["allow"].as_array().unwrap().len(), 0);
        let sink = MemorySink::new();
        sink.emit("a".into());
        sink.emit("b".into());
        assert_eq!(sink.lines(), vec!["a", "b"]);
    }
}
