//! `ALLOW_HOSTS` parsing and matching. Pure; no I/O.
//!
//! Grammar: comma-separated entries, each `host[:port]` or `*.host[:port]`.
//! The port defaults to 443. Matching is exact on (hostname, port); a `*.`
//! entry matches any strict subdomain of its base and never the base itself.

use std::fmt;

use crate::host::{normalize_hostname, HostError};

/// Port used when an entry does not name one.
pub const DEFAULT_PORT: u16 = 443;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pattern {
    /// Normalised hostname; must match exactly.
    Exact(String),
    /// Normalised base with a leading dot (`.example.com`); matches any host
    /// that ends with it and has at least one more character in front.
    Subdomains(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    pattern: Pattern,
    port: u16,
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.pattern {
            Pattern::Exact(h) => write!(f, "{h}:{}", self.port),
            Pattern::Subdomains(s) => write!(f, "*{s}:{}", self.port),
        }
    }
}

/// A malformed `ALLOW_HOSTS` entry. The proxy refuses to start on these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistError {
    pub entry: String,
    pub reason: String,
}

impl fmt::Display for AllowlistError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid ALLOW_HOSTS entry {:?}: {}",
            self.entry, self.reason
        )
    }
}

impl std::error::Error for AllowlistError {}

/// The parsed allowlist. An empty allowlist denies everything.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Allowlist {
    rules: Vec<Rule>,
}

impl Allowlist {
    /// An allowlist that denies everything.
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// Parse the value of `ALLOW_HOSTS`. An empty or all-whitespace value is
    /// the deny-all list. Any malformed entry (including an empty entry
    /// between commas) is an error.
    pub fn parse(spec: &str) -> Result<Self, AllowlistError> {
        if spec.trim().is_empty() {
            return Ok(Self::deny_all());
        }
        let mut rules: Vec<Rule> = Vec::new();
        for raw in spec.split(',') {
            let rule = parse_entry(raw.trim()).map_err(|reason| AllowlistError {
                entry: raw.to_string(),
                reason,
            })?;
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
        Ok(Self { rules })
    }

    /// Does the allowlist permit a tunnel to `host:port`?
    ///
    /// `host` is normalised here again (case, trailing dot) even though the
    /// request parser already did so; anything that fails normalisation —
    /// including every IP literal — is denied.
    pub fn allows(&self, host: &str, port: u16) -> bool {
        let Ok(host) = normalize_hostname(host) else {
            return false;
        };
        self.rules.iter().any(|r| {
            r.port == port
                && match &r.pattern {
                    Pattern::Exact(h) => *h == host,
                    Pattern::Subdomains(suffix) => {
                        host.len() > suffix.len() && host.ends_with(suffix.as_str())
                    }
                }
        })
    }

    /// Canonical `host:port` strings, for the startup log line.
    pub fn entries(&self) -> Vec<String> {
        self.rules.iter().map(ToString::to_string).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }
}

fn parse_entry(entry: &str) -> Result<Rule, String> {
    if entry.is_empty() {
        return Err("empty entry".into());
    }
    if entry.contains("://") {
        return Err("must be host[:port], not a URL".into());
    }
    if entry.starts_with('[') {
        return Err(HostError::IpLiteral.to_string());
    }
    let (host_part, port) = match entry.rsplit_once(':') {
        Some((h, p)) => (h, parse_port(p)?),
        None => (entry, DEFAULT_PORT),
    };
    if let Some(base) = host_part.strip_prefix("*.") {
        let base = normalize_hostname(base).map_err(|e| e.to_string())?;
        if !base.contains('.') {
            return Err(format!(
                "wildcard base {base:?} must have at least two labels"
            ));
        }
        Ok(Rule {
            pattern: Pattern::Subdomains(format!(".{base}")),
            port,
        })
    } else {
        if host_part.contains('*') {
            return Err("wildcard is only allowed as a leading \"*.\"".into());
        }
        let host = normalize_hostname(host_part).map_err(|e| e.to_string())?;
        Ok(Rule {
            pattern: Pattern::Exact(host),
            port,
        })
    }
}

/// Strict decimal port: 1–5 digits, no sign, no leading zero, 1..=65535.
pub(crate) fn parse_port(s: &str) -> Result<u16, String> {
    if s.is_empty() || s.len() > 5 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("invalid port {s:?}"));
    }
    if s.starts_with('0') {
        return Err(format!("invalid port {s:?}"));
    }
    match s.parse::<u32>() {
        Ok(n) if (1..=65535).contains(&n) => Ok(n as u16),
        _ => Err(format!("invalid port {s:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn al(spec: &str) -> Allowlist {
        Allowlist::parse(spec).unwrap_or_else(|e| panic!("{spec:?} should parse: {e}"))
    }

    #[test]
    fn empty_or_missing_denies_everything() {
        for spec in ["", " ", "\t", "  \n "] {
            let a = al(spec);
            assert!(a.is_empty());
            assert!(!a.allows("github.com", 443));
            assert!(!a.allows("api.anthropic.com", 443));
            assert!(!a.allows("localhost", 443));
            assert!(!a.allows("", 443));
        }
        assert!(!Allowlist::deny_all().allows("github.com", 443));
    }

    #[test]
    fn exact_match_default_port() {
        let a = al("api.anthropic.com,github.com");
        assert_eq!(a.len(), 2);
        assert!(a.allows("github.com", 443));
        assert!(a.allows("api.anthropic.com", 443));
        assert!(!a.allows("example.com", 443));
        assert_eq!(a.entries(), vec!["api.anthropic.com:443", "github.com:443"]);
    }

    #[test]
    fn exact_match_is_not_a_suffix_prefix_or_substring_match() {
        let a = al("github.com");
        for h in [
            "evilgithub.com",
            "github.com.evil.com",
            "api.github.com",
            "www.github.com",
            "github.co",
            "github.comm",
            "ithub.com",
            "com",
            "github",
            "github.com.com",
            "xgithub.com",
            "github-com",
            "github.com-evil.net",
        ] {
            assert!(!a.allows(h, 443), "{h}");
        }
    }

    #[test]
    fn case_insensitive_both_sides() {
        let a = al("GitHub.COM,API.Anthropic.com");
        assert!(a.allows("github.com", 443));
        assert!(a.allows("GITHUB.COM", 443));
        assert!(a.allows("gItHuB.cOm", 443));
        assert!(a.allows("api.anthropic.COM", 443));
        assert_eq!(a.entries(), vec!["github.com:443", "api.anthropic.com:443"]);
    }

    #[test]
    fn trailing_dot_normalised_both_sides() {
        let a = al("github.com.");
        assert!(a.allows("github.com", 443));
        assert!(a.allows("github.com.", 443));
        let b = al("github.com");
        assert!(b.allows("github.com.", 443));
        assert!(b.allows("GITHUB.COM.", 443));
        // Only one trailing dot is a valid FQDN spelling.
        assert!(!b.allows("github.com..", 443));
        let c = al("*.example.com.:8443");
        assert!(c.allows("a.example.com.", 8443));
    }

    #[test]
    fn port_must_match() {
        let a = al("github.com");
        assert!(a.allows("github.com", 443));
        for p in [0, 1, 22, 80, 442, 444, 8443, 9418, 65535] {
            assert!(!a.allows("github.com", p), "port {p}");
        }
        let b = al("github.com:22");
        assert!(b.allows("github.com", 22));
        assert!(!b.allows("github.com", 443));
        let c = al("github.com,github.com:22,github.com:65535,github.com:1");
        assert!(c.allows("github.com", 443));
        assert!(c.allows("github.com", 22));
        assert!(c.allows("github.com", 65535));
        assert!(c.allows("github.com", 1));
        assert!(!c.allows("github.com", 80));
    }

    #[test]
    fn wildcard_matches_subdomains_only_not_apex() {
        let a = al("*.example.com");
        assert!(a.allows("a.example.com", 443));
        assert!(a.allows("A.Example.Com.", 443));
        assert!(a.allows("a.b.example.com", 443));
        assert!(a.allows("x-1.y.z.example.com", 443));
        assert!(!a.allows("example.com", 443), "apex must not match");
        assert!(!a.allows("example.com.", 443));
        assert!(!a.allows("evilexample.com", 443));
        assert!(!a.allows("notexample.com", 443));
        assert!(!a.allows("a.example.com.evil.net", 443));
        assert!(!a.allows("example.com.evil.net", 443));
        assert!(!a.allows("a.example.org", 443));
        assert!(!a.allows(".example.com", 443));
        assert!(!a.allows("a..example.com", 443));
        assert!(!a.allows("a.example.com", 80), "port still applies");
        assert_eq!(a.entries(), vec!["*.example.com:443"]);
    }

    #[test]
    fn wildcard_and_apex_are_independent_entries() {
        let a = al("example.com,*.example.com:8443");
        assert!(a.allows("example.com", 443));
        assert!(!a.allows("a.example.com", 443));
        assert!(a.allows("a.example.com", 8443));
        assert!(!a.allows("example.com", 8443));
    }

    #[test]
    fn whitespace_around_entries_is_trimmed_and_duplicates_collapse() {
        let a = al(" github.com , api.anthropic.com:443 ,GITHUB.com.");
        assert_eq!(a.entries(), vec!["github.com:443", "api.anthropic.com:443"]);
    }

    #[test]
    fn ip_literals_are_never_allowed_even_if_everything_else_is() {
        let a = al("*.example.com,github.com");
        for h in [
            "127.0.0.1",
            "0x7f.1",
            "2130706433",
            "::1",
            "[::1]",
            "::ffff:127.0.0.1",
            "169.254.169.254",
            "1.1.1.1",
        ] {
            assert!(!a.allows(h, 443), "{h}");
        }
    }

    #[test]
    fn invalid_hosts_never_match() {
        let a = al("github.com,*.example.com");
        for h in [
            "",
            ".",
            "github.com/..",
            "github.com@evil.net",
            "evil.net#.example.com",
            "evil.net/.example.com",
            "evil.net?.example.com",
            "evil.net\\.example.com",
            "a b.example.com",
            "a\0.example.com",
            "a\r\n.example.com",
            "github.com\0",
            "github.com ",
            " github.com",
            "*.example.com",
        ] {
            assert!(!a.allows(h, 443), "{h:?}");
        }
    }

    #[test]
    fn malformed_entries_are_rejected() {
        for spec in [
            ",",
            "github.com,",
            ",github.com",
            "github.com,,api.anthropic.com",
            "github.com:",
            "github.com:0",
            "github.com:65536",
            "github.com:99999",
            "github.com:123456",
            "github.com:-1",
            "github.com:+443",
            "github.com:0443",
            "github.com:44a",
            "github.com: 443",
            "github.com:443:443",
            ":443",
            "https://github.com",
            "http://github.com:80",
            "github.com/path",
            "github.com:443/path",
            "user@github.com",
            "git hub.com",
            "github.com;api.anthropic.com",
            "github.com api.anthropic.com",
            "*",
            "*:443",
            "*.",
            "*.com",
            "*.*.example.com",
            "a.*.example.com",
            "*example.com",
            "ex*mple.com",
            "example.*",
            "**.example.com",
            "*..example.com",
            "*.127.0.0.1",
            "127.0.0.1",
            "127.0.0.1:443",
            "0x7f.1",
            "2130706433",
            "::1",
            "[::1]",
            "[::1]:443",
            "[2606:4700::1111]:443",
            "-bad.com",
            "bad-.com",
            "a..b.com",
            "bücher.example",
            "under_score.example.com",
        ] {
            let r = Allowlist::parse(spec);
            assert!(r.is_err(), "{spec:?} should be rejected, got {r:?}");
        }
    }

    #[test]
    fn error_names_the_offending_entry() {
        let e = Allowlist::parse("github.com,exa mple.com").unwrap_err();
        assert_eq!(e.entry, "exa mple.com");
        assert!(e.to_string().contains("exa mple.com"));
    }

    #[test]
    fn parse_port_boundaries() {
        assert_eq!(parse_port("1"), Ok(1));
        assert_eq!(parse_port("443"), Ok(443));
        assert_eq!(parse_port("65535"), Ok(65535));
        for bad in [
            "",
            "0",
            "00",
            "01",
            "65536",
            "70000",
            "100000",
            " 1",
            "1 ",
            "1e3",
            "0x50",
            "４４３",
        ] {
            assert!(parse_port(bad).is_err(), "{bad:?}");
        }
    }
}
