//! Runtime configuration. Parsing is pure: the environment is passed in as a
//! lookup function so tests never mutate process state.

use std::fmt;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use crate::allowlist::Allowlist;

pub const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:3128";
pub const DEFAULT_MAX_CONNS: usize = 256;
/// Upper bound for `MAX_CONNS`; keeps the value inside semaphore limits and
/// well within any sane file-descriptor budget (two sockets per tunnel).
pub const MAX_MAX_CONNS: usize = 65_536;
pub const DEFAULT_HEADER_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Everything the server needs. Construct with [`Config::new`] (defaults) or
/// [`Config::from_lookup`] (environment).
#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub allowlist: Allowlist,
    /// Disables the resolved-address guard. For tests only.
    pub allow_private_upstreams: bool,
    pub max_conns: usize,
    /// Total time allowed for the client to deliver its request head.
    pub header_timeout: Duration,
    /// Total time allowed for DNS resolution plus TCP connect.
    pub connect_timeout: Duration,
    /// A tunnel with no bytes in either direction for this long is closed.
    pub idle_timeout: Duration,
    /// On SIGTERM/SIGINT, how long open tunnels may keep running.
    pub shutdown_grace: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Defaults with the given allowlist.
    pub fn new(allowlist: Allowlist) -> Self {
        Self {
            listen_addr: SocketAddr::from((Ipv4Addr::UNSPECIFIED, 3128)),
            allowlist,
            allow_private_upstreams: false,
            max_conns: DEFAULT_MAX_CONNS,
            header_timeout: DEFAULT_HEADER_TIMEOUT,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        }
    }

    /// Build from an environment-like lookup. Unset and empty variables take
    /// their defaults; anything malformed is an error (the proxy refuses to
    /// start rather than guess).
    pub fn from_lookup<F>(get: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let var = |name: &str| get(name).filter(|v| !v.trim().is_empty());

        let allowlist = Allowlist::parse(&get("ALLOW_HOSTS").unwrap_or_default())
            .map_err(|e| ConfigError(e.to_string()))?;
        let mut cfg = Self::new(allowlist);

        if let Some(v) = var("LISTEN_ADDR") {
            cfg.listen_addr = parse_listen_addr(&v)?;
        }
        if let Some(v) = var("ALLOW_PRIVATE_UPSTREAMS") {
            cfg.allow_private_upstreams = parse_bool("ALLOW_PRIVATE_UPSTREAMS", &v)?;
        }
        if let Some(v) = var("MAX_CONNS") {
            cfg.max_conns = parse_int("MAX_CONNS", &v, 1, MAX_MAX_CONNS as u64)? as usize;
        }
        if let Some(v) = var("HEADER_TIMEOUT_SECS") {
            cfg.header_timeout = parse_secs("HEADER_TIMEOUT_SECS", &v)?;
        }
        if let Some(v) = var("CONNECT_TIMEOUT_SECS") {
            cfg.connect_timeout = parse_secs("CONNECT_TIMEOUT_SECS", &v)?;
        }
        if let Some(v) = var("IDLE_TIMEOUT_SECS") {
            cfg.idle_timeout = parse_secs("IDLE_TIMEOUT_SECS", &v)?;
        }
        if let Some(v) = var("SHUTDOWN_GRACE_SECS") {
            cfg.shutdown_grace = parse_secs("SHUTDOWN_GRACE_SECS", &v)?;
        }
        Ok(cfg)
    }
}

/// `ip:port`, `[v6]:port`, or the Go-style shorthand `:port` (all IPv4
/// interfaces).
pub fn parse_listen_addr(s: &str) -> Result<SocketAddr, ConfigError> {
    let s = s.trim();
    let full = if s.starts_with(':') {
        format!("0.0.0.0{s}")
    } else {
        s.to_string()
    };
    full.parse::<SocketAddr>()
        .map_err(|_| ConfigError(format!("invalid LISTEN_ADDR {s:?}: expected ip:port")))
}

fn parse_bool(name: &str, v: &str) -> Result<bool, ConfigError> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(ConfigError(format!(
            "invalid {name} {v:?}: expected true or false"
        ))),
    }
}

fn parse_int(name: &str, v: &str, min: u64, max: u64) -> Result<u64, ConfigError> {
    let t = v.trim();
    let err = || {
        ConfigError(format!(
            "invalid {name} {v:?}: expected integer {min}..={max}"
        ))
    };
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return Err(err());
    }
    match t.parse::<u64>() {
        Ok(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(err()),
    }
}

fn parse_secs(name: &str, v: &str) -> Result<Duration, ConfigError> {
    parse_int(name, v, 1, 86_400).map(Duration::from_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults_deny_everything() {
        let c = cfg(&[]).unwrap();
        assert_eq!(c.listen_addr.to_string(), "0.0.0.0:3128");
        assert_eq!(c.listen_addr.to_string(), DEFAULT_LISTEN_ADDR);
        assert!(c.allowlist.is_empty());
        assert!(!c.allowlist.allows("github.com", 443));
        assert!(!c.allow_private_upstreams);
        assert_eq!(c.max_conns, 256);
        assert_eq!(c.header_timeout, Duration::from_secs(10));
        assert_eq!(c.connect_timeout, Duration::from_secs(10));
        assert_eq!(c.idle_timeout, Duration::from_secs(300));
        assert_eq!(c.shutdown_grace, Duration::from_secs(5));
    }

    #[test]
    fn empty_values_mean_default() {
        let c = cfg(&[
            ("ALLOW_HOSTS", ""),
            ("LISTEN_ADDR", ""),
            ("MAX_CONNS", " "),
            ("ALLOW_PRIVATE_UPSTREAMS", ""),
        ])
        .unwrap();
        assert!(c.allowlist.is_empty());
        assert_eq!(c.max_conns, 256);
        assert!(!c.allow_private_upstreams);
    }

    #[test]
    fn full_configuration() {
        let c = cfg(&[
            ("ALLOW_HOSTS", "api.anthropic.com,github.com:22"),
            ("LISTEN_ADDR", "127.0.0.1:8080"),
            ("ALLOW_PRIVATE_UPSTREAMS", "true"),
            ("MAX_CONNS", "16"),
            ("HEADER_TIMEOUT_SECS", "3"),
            ("CONNECT_TIMEOUT_SECS", "4"),
            ("IDLE_TIMEOUT_SECS", "60"),
            ("SHUTDOWN_GRACE_SECS", "1"),
        ])
        .unwrap();
        assert_eq!(c.listen_addr.to_string(), "127.0.0.1:8080");
        assert!(c.allowlist.allows("api.anthropic.com", 443));
        assert!(c.allowlist.allows("github.com", 22));
        assert!(c.allow_private_upstreams);
        assert_eq!(c.max_conns, 16);
        assert_eq!(c.header_timeout, Duration::from_secs(3));
        assert_eq!(c.connect_timeout, Duration::from_secs(4));
        assert_eq!(c.idle_timeout, Duration::from_secs(60));
        assert_eq!(c.shutdown_grace, Duration::from_secs(1));
    }

    #[test]
    fn malformed_allowlist_refuses_to_start() {
        let e = cfg(&[("ALLOW_HOSTS", "github.com,127.0.0.1")]).unwrap_err();
        assert!(e.to_string().contains("127.0.0.1"), "{e}");
        assert!(cfg(&[("ALLOW_HOSTS", "github.com,")]).is_err());
        assert!(cfg(&[("ALLOW_HOSTS", "https://github.com")]).is_err());
    }

    #[test]
    fn listen_addr_forms() {
        assert_eq!(
            parse_listen_addr(":3128").unwrap().to_string(),
            "0.0.0.0:3128"
        );
        assert_eq!(
            parse_listen_addr("[::]:3128").unwrap().to_string(),
            "[::]:3128"
        );
        assert_eq!(
            parse_listen_addr(" 10.0.0.1:1 ").unwrap().to_string(),
            "10.0.0.1:1"
        );
        for bad in [
            "3128",
            "localhost:3128",
            "0.0.0.0",
            "0.0.0.0:99999",
            ":",
            "::",
        ] {
            assert!(parse_listen_addr(bad).is_err(), "{bad}");
        }
        assert!(cfg(&[("LISTEN_ADDR", "nope")]).is_err());
    }

    #[test]
    fn allow_private_upstreams_values() {
        for v in ["true", "TRUE", "True", "1"] {
            assert!(
                cfg(&[("ALLOW_PRIVATE_UPSTREAMS", v)])
                    .unwrap()
                    .allow_private_upstreams
            );
        }
        for v in ["false", "FALSE", "0"] {
            assert!(
                !cfg(&[("ALLOW_PRIVATE_UPSTREAMS", v)])
                    .unwrap()
                    .allow_private_upstreams
            );
        }
        for v in ["yes", "on", "2", "tru", "enabled"] {
            assert!(cfg(&[("ALLOW_PRIVATE_UPSTREAMS", v)]).is_err(), "{v}");
        }
    }

    #[test]
    fn numeric_bounds() {
        assert_eq!(cfg(&[("MAX_CONNS", "1")]).unwrap().max_conns, 1);
        assert_eq!(cfg(&[("MAX_CONNS", "65536")]).unwrap().max_conns, 65_536);
        for bad in [
            "0",
            "65537",
            "-1",
            "+5",
            "1.5",
            "abc",
            "1e3",
            "99999999999999999999999",
        ] {
            assert!(cfg(&[("MAX_CONNS", bad)]).is_err(), "{bad}");
        }
        for name in [
            "HEADER_TIMEOUT_SECS",
            "CONNECT_TIMEOUT_SECS",
            "IDLE_TIMEOUT_SECS",
            "SHUTDOWN_GRACE_SECS",
        ] {
            assert!(cfg(&[(name, "0")]).is_err(), "{name}=0");
            assert!(cfg(&[(name, "86401")]).is_err(), "{name}=86401");
            assert!(cfg(&[(name, "10s")]).is_err(), "{name}=10s");
            assert!(cfg(&[(name, "86400")]).is_ok(), "{name}=86400");
        }
    }
}
