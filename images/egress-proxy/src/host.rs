//! Hostname normalisation and IP-literal detection. Pure; no I/O.
//!
//! A hostname that survives [`normalize_hostname`] is lower-case ASCII, has no
//! trailing dot, consists only of LDH labels, and is guaranteed not to be
//! something a libc resolver (`inet_aton`, `getaddrinfo`) would interpret as a
//! numeric address.

use std::fmt;

/// Maximum length of a hostname in presentation form (RFC 1035), without the
/// trailing dot.
pub const MAX_HOSTNAME_LEN: usize = 253;
/// Maximum length of a single DNS label.
pub const MAX_LABEL_LEN: usize = 63;

/// Why a string was rejected as a hostname.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    /// Empty string, or only a dot.
    Empty,
    /// Longer than [`MAX_HOSTNAME_LEN`].
    TooLong,
    /// An IPv4/IPv6 literal in any spelling (dotted, decimal, hex, octal,
    /// shortened, bracketed).
    IpLiteral,
    /// Empty label, over-long label, or label starting/ending with `-`.
    BadLabel,
    /// A character outside `[A-Za-z0-9-.]`.
    BadChar,
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HostError::Empty => "empty hostname",
            HostError::TooLong => "hostname too long",
            HostError::IpLiteral => "IP literals are not allowed",
            HostError::BadLabel => "invalid hostname label",
            HostError::BadChar => "invalid character in hostname",
        })
    }
}

/// Normalise `raw` into canonical form: ASCII lower-case, one trailing dot
/// removed. Rejects anything that is not a plain LDH hostname and anything
/// that could be read as an IP address.
pub fn normalize_hostname(raw: &str) -> Result<String, HostError> {
    if raw.is_empty() {
        return Err(HostError::Empty);
    }
    // Anything with a colon or bracket can only be an IPv6 literal (ports are
    // split off by the caller before this function is reached).
    if raw.contains([':', '[', ']']) {
        return Err(HostError::IpLiteral);
    }
    let s = raw.strip_suffix('.').unwrap_or(raw);
    if s.is_empty() {
        return Err(HostError::Empty);
    }
    if s.len() > MAX_HOSTNAME_LEN {
        return Err(HostError::TooLong);
    }
    let lower = s.to_ascii_lowercase();
    for label in lower.split('.') {
        if label.is_empty() || label.len() > MAX_LABEL_LEN {
            return Err(HostError::BadLabel);
        }
        if !label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(HostError::BadChar);
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(HostError::BadLabel);
        }
    }
    if ends_in_number(&lower) {
        return Err(HostError::IpLiteral);
    }
    Ok(lower)
}

/// The WHATWG URL "ends in a number" rule: if the last label is numeric
/// (decimal/octal digits, or `0x` followed by hex digits), `inet_aton`-style
/// parsers may treat the whole host as an IPv4 address (`127.1`, `0x7f.1`,
/// `2130706433`, `0177.0.0.1`, ...). No real TLD is numeric, so rejecting all
/// such names loses nothing.
///
/// `host` must already be lower-case and without a trailing dot.
pub fn ends_in_number(host: &str) -> bool {
    let last = host.rsplit('.').next().unwrap_or(host);
    is_numeric_label(last)
}

fn is_numeric_label(label: &str) -> bool {
    if label.is_empty() {
        return false;
    }
    if label.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    match label.strip_prefix("0x") {
        Some(hex) => hex.bytes().all(|b| b.is_ascii_hexdigit()),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_and_normalises_plain_hostnames() {
        assert_eq!(normalize_hostname("github.com").unwrap(), "github.com");
        assert_eq!(normalize_hostname("GitHub.COM").unwrap(), "github.com");
        assert_eq!(normalize_hostname("github.com.").unwrap(), "github.com");
        assert_eq!(
            normalize_hostname("API.Anthropic.Com.").unwrap(),
            "api.anthropic.com"
        );
        assert_eq!(normalize_hostname("localhost").unwrap(), "localhost");
        assert_eq!(
            normalize_hostname("xn--bcher-kva.example").unwrap(),
            "xn--bcher-kva.example"
        );
        assert_eq!(normalize_hostname("a-b.c1.d").unwrap(), "a-b.c1.d");
        assert_eq!(normalize_hostname("1e100.net").unwrap(), "1e100.net");
        assert_eq!(
            normalize_hostname("3.example.com").unwrap(),
            "3.example.com"
        );
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(normalize_hostname(""), Err(HostError::Empty));
        assert_eq!(normalize_hostname("."), Err(HostError::Empty));
    }

    #[test]
    fn rejects_bad_labels() {
        for h in [
            "..", "a..b", ".a", "a.com..", "-a.com", "a-.com", "a.-b.com",
        ] {
            assert_eq!(normalize_hostname(h), Err(HostError::BadLabel), "{h}");
        }
        let long_label = format!("{}.com", "a".repeat(64));
        assert_eq!(normalize_hostname(&long_label), Err(HostError::BadLabel));
        let ok_label = format!("{}.com", "a".repeat(63));
        assert!(normalize_hostname(&ok_label).is_ok());
    }

    #[test]
    fn rejects_bad_chars() {
        for h in [
            "a b.com",
            "a_b.com",
            "user@host.com",
            "host.com/path",
            "exa%6dple.com",
            "bücher.example",
            "a.com\0",
            "a.com\r\n",
            "a\t.com",
            "*.a.com",
            "a.com?x",
            "a.com#x",
            "a\\b.com",
            "ａ.com",
            "a。com",
        ] {
            assert_eq!(normalize_hostname(h), Err(HostError::BadChar), "{h:?}");
        }
    }

    #[test]
    fn length_boundaries() {
        // 253 chars: 4 labels of 61 + 3 dots = 247 ... build exactly 253.
        let label = "a".repeat(49);
        let mut parts = vec![label.clone(); 5]; // 5*49 + 4 dots = 249
        parts.push("abc".to_string()); // +1 dot +3 = 253
        let h = parts.join(".");
        assert_eq!(h.len(), 253);
        assert!(normalize_hostname(&h).is_ok());
        // Trailing dot does not count.
        assert!(normalize_hostname(&format!("{h}.")).is_ok());
        let too_long = format!("a{h}");
        assert_eq!(too_long.len(), 254);
        assert_eq!(normalize_hostname(&too_long), Err(HostError::TooLong));
    }

    #[test]
    fn rejects_ipv4_literals_in_every_spelling() {
        for h in [
            "127.0.0.1",
            "127.0.0.1.",
            "1.1.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "255.255.255.255",
            // shortened forms accepted by inet_aton
            "127.1",
            "127.0.1",
            "10.1",
            "1",
            "0",
            // single decimal integer
            "2130706433",
            "3232235521",
            "4294967295",
            "99999999999999999999",
            // hex
            "0x7f.1",
            "0x7f.0.0.1",
            "0x7f000001",
            "0X7F000001",
            "0x7F.0x0.0x0.0x1",
            "127.0.0.0x1",
            "0x",
            "example.0x",
            // octal
            "0177.0.0.1",
            "017700000001",
            "0177.1",
            "00000177.0.0.01",
            // mixed
            "0x7f.0.0.01",
            "10.0x0.0.1",
            // too many parts but still numeric-looking
            "1.2.3.4.5",
            // name that ends in a number
            "example.123",
            "example.com.0x1f",
            "foo.127.0.0.1",
        ] {
            assert_eq!(normalize_hostname(h), Err(HostError::IpLiteral), "{h}");
        }
    }

    #[test]
    fn rejects_ipv6_literals() {
        for h in [
            "::1",
            "[::1]",
            "::",
            "[::]",
            "::ffff:127.0.0.1",
            "[::ffff:127.0.0.1]",
            "::ffff:7f00:1",
            "fe80::1",
            "fe80::1%eth0",
            "[fe80::1%25eth0]",
            "2001:db8::1",
            "[2606:4700:4700::1111]",
            "0:0:0:0:0:0:0:1",
            "[",
            "]",
            "a:b",
        ] {
            assert_eq!(normalize_hostname(h), Err(HostError::IpLiteral), "{h}");
        }
    }

    #[test]
    fn ends_in_number_only_looks_at_last_label() {
        assert!(!ends_in_number("1.2.3.com"));
        assert!(!ends_in_number("0x7f.example"));
        assert!(!ends_in_number("123abc"));
        assert!(!ends_in_number("0xzz"));
        assert!(!ends_in_number("x0"));
        assert!(ends_in_number("a.b.0"));
        assert!(ends_in_number("0xdeadbeef"));
    }
}
